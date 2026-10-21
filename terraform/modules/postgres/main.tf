variable "name" { type = string }
variable "database" { type = string }
variable "username" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "allocated_storage" {
  type    = number
  default = 50
}
variable "multi_az" {
  type    = bool
  default = true
}
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "backup_retention_days" {
  type    = number
  default = 14
}

resource "random_password" "this" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${var.name}-postgres"
  description = "PostgreSQL access for ${var.name}"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }
}

resource "aws_db_instance" "this" {
  identifier                          = var.name
  engine                              = "postgres"
  engine_version                      = "17"
  instance_class                      = var.instance_class
  allocated_storage                   = var.allocated_storage
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = var.database
  username                            = var.username
  password                            = random_password.this.result
  multi_az                            = var.multi_az
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.this.id]
  publicly_accessible                 = false
  backup_retention_period             = var.backup_retention_days
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = var.deletion_protection ? "${var.name}-final" : null
  iam_database_authentication_enabled = true
  performance_insights_enabled        = true
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  auto_minor_version_upgrade          = true
  copy_tags_to_snapshot               = true
}

resource "aws_secretsmanager_secret" "url" {
  name                    = "${var.name}/database-url"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "url" {
  secret_id     = aws_secretsmanager_secret.url.id
  secret_string = "postgresql://${var.username}:${random_password.this.result}@${aws_db_instance.this.address}:5432/${var.database}?sslmode=require"
}

output "url_secret_arn" { value = aws_secretsmanager_secret.url.arn }
output "security_group_id" { value = aws_security_group.this.id }
output "endpoint" { value = aws_db_instance.this.address }
