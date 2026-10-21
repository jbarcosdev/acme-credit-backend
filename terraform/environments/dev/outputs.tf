output "public_alb_dns" { value = module.public_alb.dns_name }
output "ecr_repositories" { value = module.ecr.repository_urls }
output "limit_events_dlq_arn" { value = module.messaging.dlq_arn }
output "migration_task_definitions" {
  value = {
    lending    = module.lending_migrate.task_definition_arn
    collateral = module.collateral_migrate.task_definition_arn
  }
}
