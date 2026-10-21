variable "name" { type = string }
variable "internal" { type = bool }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "ingress_cidrs" {
  type    = list(string)
  default = []
}
variable "ingress_security_group_ids" {
  type    = list(string)
  default = []
}
variable "certificate_arn" {
  type    = string
  default = null
}
variable "target_groups" {
  type = map(object({
    port              = number
    health_check_path = string
    path_patterns     = list(string)
    priority          = number
  }))
}
variable "default_target_group" { type = string }
variable "enable_waf" {
  type    = bool
  default = false
}
variable "waf_rate_limit" {
  type    = number
  default = 2000
}

locals {
  https = var.certificate_arn != null
  port  = local.https ? 443 : 80
}

resource "aws_security_group" "this" {
  name        = "${var.name}-alb"
  description = "Load balancer ${var.name}"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = local.port
    to_port         = local.port
    protocol        = "tcp"
    cidr_blocks     = var.ingress_cidrs
    security_groups = var.ingress_security_group_ids
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name                       = var.name
  internal                   = var.internal
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.this.id]
  subnets                    = var.subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "this" {
  for_each             = var.target_groups
  name                 = "${var.name}-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = each.value.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }
}

resource "aws_lb_listener" "this" {
  load_balancer_arn = aws_lb.this.arn
  port              = local.port
  protocol          = local.https ? "HTTPS" : "HTTP"
  ssl_policy        = local.https ? "ELBSecurityPolicy-TLS13-1-2-2021-06" : null
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[var.default_target_group].arn
  }
}

resource "aws_lb_listener_rule" "this" {
  for_each     = { for name, tg in var.target_groups : name => tg if length(tg.path_patterns) > 0 }
  listener_arn = aws_lb_listener.this.arn
  priority     = each.value.priority
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }
  condition {
    path_pattern {
      values = each.value.path_patterns
    }
  }
}

resource "aws_wafv2_web_acl" "this" {
  count = var.enable_waf ? 1 : 0
  name  = "${var.name}-waf"
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  rule {
    name     = "rate-limit"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "aws-common"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  count        = var.enable_waf ? 1 : 0
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this[0].arn
}

output "dns_name" { value = aws_lb.this.dns_name }
output "security_group_id" { value = aws_security_group.this.id }
output "target_group_arns" { value = { for name, tg in aws_lb_target_group.this : name => tg.arn } }
