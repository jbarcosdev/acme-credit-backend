locals {
  name = "acme-credit-${var.environment}"
}

module "network" {
  source = "../../modules/network"
  name   = local.name
}

module "ecr" {
  source       = "../../modules/ecr"
  repositories = ["lending", "collateral"]
}

module "messaging" {
  source = "../../modules/messaging"
  name   = local.name
}

resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_security_group" "lending" {
  name        = "${local.name}-lending"
  description = "Lending tasks and jobs"
  vpc_id      = module.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "collateral" {
  name        = "${local.name}-collateral"
  description = "Collateral tasks and jobs"
  vpc_id      = module.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

module "lending_db" {
  source                     = "../../modules/postgres"
  name                       = "${local.name}-lending"
  database                   = "lending"
  username                   = "lending"
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.lending.id]
  multi_az                   = var.multi_az
  deletion_protection        = var.deletion_protection
}

module "collateral_db" {
  source                     = "../../modules/postgres"
  name                       = "${local.name}-collateral"
  database                   = "collateral"
  username                   = "collateral"
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.collateral.id]
  multi_az                   = var.multi_az
  deletion_protection        = var.deletion_protection
}

module "redis" {
  source                     = "../../modules/redis"
  name                       = "${local.name}-cache"
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  allowed_security_group_ids = [aws_security_group.lending.id]
  replicas                   = var.multi_az ? 1 : 0
}

resource "aws_secretsmanager_secret" "auth_public_key" {
  name                    = "${local.name}/auth-public-key"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "service_private_key" {
  name                    = "${local.name}/lending-service-private-key"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "bank_public_keys" {
  name                    = "${local.name}/bank-public-keys"
  recovery_window_in_days = 7
}

module "public_alb" {
  source               = "../../modules/alb"
  name                 = "${local.name}-public"
  internal             = false
  vpc_id               = module.network.vpc_id
  subnet_ids           = module.network.public_subnet_ids
  ingress_cidrs        = var.public_ingress_cidrs
  certificate_arn      = var.certificate_arn
  enable_waf           = true
  default_target_group = "lending"
  target_groups = {
    lending = {
      port              = 3000
      health_check_path = "/health"
      path_patterns     = []
      priority          = 0
    }
    collateral = {
      port              = 3001
      health_check_path = "/health"
      path_patterns     = ["/custody-accounts*", "/webhooks/banks/*"]
      priority          = 10
    }
  }
}

module "internal_alb" {
  source                     = "../../modules/alb"
  name                       = "${local.name}-internal"
  internal                   = true
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  ingress_security_group_ids = [aws_security_group.lending.id]
  default_target_group       = "collateral"
  target_groups = {
    collateral = {
      port              = 3001
      health_check_path = "/health"
      path_patterns     = []
      priority          = 0
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "lending_from_public_alb" {
  security_group_id            = aws_security_group.lending.id
  referenced_security_group_id = module.public_alb.security_group_id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "collateral_from_public_alb" {
  security_group_id            = aws_security_group.collateral.id
  referenced_security_group_id = module.public_alb.security_group_id
  from_port                    = 3001
  to_port                      = 3001
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "collateral_from_internal_alb" {
  security_group_id            = aws_security_group.collateral.id
  referenced_security_group_id = module.internal_alb.security_group_id
  from_port                    = 3001
  to_port                      = 3001
  ip_protocol                  = "tcp"
}

data "aws_iam_policy_document" "lending_task" {
  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [module.messaging.queue_arn]
  }
}

data "aws_iam_policy_document" "collateral_task" {
  statement {
    actions   = ["sns:Publish"]
    resources = [module.messaging.topic_arn]
  }
}

data "aws_iam_policy_document" "no_access" {
  statement {
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

locals {
  lending_image    = "${module.ecr.repository_urls["lending"]}:${var.image_tag}"
  collateral_image = "${module.ecr.repository_urls["collateral"]}:${var.image_tag}"
  aws_region       = var.region

  lending_environment = {
    PORT                     = "3000"
    NODE_ENV                 = "production"
    AUTH_ISSUER              = var.auth_issuer
    AUTH_AUDIENCE            = var.auth_audience
    SERVICE_ID               = "lending"
    CUSTODY_URL              = "http://${module.internal_alb.dns_name}"
    EVENT_BUS                = "sqs"
    LIMIT_EVENTS_QUEUE_URL   = module.messaging.queue_url
    AWS_REGION               = local.aws_region
    LIMIT_UNAVAILABLE_POLICY = "deny"
    LIMIT_CACHE_TTL_SECONDS  = "43200"
    LIMIT_REQUEST_TIMEOUT_MS = "200"
  }
  lending_secrets = {
    DATABASE_URL        = module.lending_db.url_secret_arn
    REDIS_URL           = module.redis.url_secret_arn
    AUTH_PUBLIC_KEY     = aws_secretsmanager_secret.auth_public_key.arn
    SERVICE_PRIVATE_KEY = aws_secretsmanager_secret.service_private_key.arn
  }
  collateral_environment = {
    PORT                 = "3001"
    NODE_ENV             = "production"
    AUTH_ISSUER          = var.auth_issuer
    AUTH_AUDIENCE        = var.auth_audience
    EVENT_BUS            = "sns"
    EVENTS_TOPIC_ARN     = module.messaging.topic_arn
    AWS_REGION           = local.aws_region
    COLLATERAL_RATIO_BPS = "9000"
  }
  collateral_secrets = {
    DATABASE_URL        = module.collateral_db.url_secret_arn
    AUTH_PUBLIC_KEY     = aws_secretsmanager_secret.auth_public_key.arn
    BANK_SIM_PUBLIC_KEY = aws_secretsmanager_secret.bank_public_keys.arn
  }
}

module "lending" {
  source             = "../../modules/ecs-service"
  name               = "lending"
  cluster_arn        = aws_ecs_cluster.this.arn
  cluster_name       = aws_ecs_cluster.this.name
  image              = local.lending_image
  port               = 3000
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.lending.id]
  target_group_arn   = module.public_alb.target_group_arns["lending"]
  environment        = local.lending_environment
  secrets            = local.lending_secrets
  task_policy_json   = data.aws_iam_policy_document.lending_task.json
}

module "collateral" {
  source             = "../../modules/ecs-service"
  name               = "collateral"
  cluster_arn        = aws_ecs_cluster.this.arn
  cluster_name       = aws_ecs_cluster.this.name
  image              = local.collateral_image
  port               = 3001
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.collateral.id]
  target_group_arn   = module.public_alb.target_group_arns["collateral"]
  environment        = local.collateral_environment
  secrets            = local.collateral_secrets
  task_policy_json   = data.aws_iam_policy_document.collateral_task.json
}

module "lending_daily_jobs" {
  source              = "../../modules/ecs-job"
  name                = "lending-daily-jobs"
  cluster_arn         = aws_ecs_cluster.this.arn
  image               = local.lending_image
  command             = ["node", "dist/cli/daily-jobs.js"]
  subnet_ids          = module.network.private_subnet_ids
  security_group_ids  = [aws_security_group.lending.id]
  environment         = merge(local.lending_environment, { EVENT_BUS = "memory" })
  secrets             = local.lending_secrets
  task_policy_json    = data.aws_iam_policy_document.no_access.json
  schedule_expression = "cron(15 0 * * ? *)"
}

module "lending_migrate" {
  source             = "../../modules/ecs-job"
  name               = "lending-migrate"
  cluster_arn        = aws_ecs_cluster.this.arn
  image              = "${module.ecr.repository_urls["lending"]}:${var.image_tag}-migrate"
  command            = ["pnpm", "exec", "prisma", "migrate", "deploy"]
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.lending.id]
  secrets            = { DATABASE_URL = module.lending_db.url_secret_arn }
  task_policy_json   = data.aws_iam_policy_document.no_access.json
}

module "collateral_migrate" {
  source             = "../../modules/ecs-job"
  name               = "collateral-migrate"
  cluster_arn        = aws_ecs_cluster.this.arn
  image              = "${module.ecr.repository_urls["collateral"]}:${var.image_tag}-migrate"
  command            = ["pnpm", "exec", "prisma", "migrate", "deploy"]
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.collateral.id]
  secrets            = { DATABASE_URL = module.collateral_db.url_secret_arn }
  task_policy_json   = data.aws_iam_policy_document.no_access.json
}
