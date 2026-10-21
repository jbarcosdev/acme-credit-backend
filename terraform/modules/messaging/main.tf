variable "name" { type = string }
variable "alarm_topic_arn" {
  type    = string
  default = null
}
variable "max_receive_count" {
  type    = number
  default = 5
}

resource "aws_sns_topic" "events" {
  name              = "${var.name}-custody-events"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-lending-limit-events-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "limit_events" {
  name                       = "${var.name}-lending-limit-events"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 30
  receive_wait_time_seconds  = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "AllowSnsPublish"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.limit_events.arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "limit_events" {
  queue_url = aws_sqs_queue.limit_events.id
  policy    = data.aws_iam_policy_document.queue.json
}

resource "aws_sns_topic_subscription" "limit_events" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.limit_events.arn
  raw_message_delivery = true
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name}-limit-events-dlq-not-empty"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "oldest_message" {
  alarm_name          = "${var.name}-limit-events-oldest-message"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.limit_events.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}

output "topic_arn" { value = aws_sns_topic.events.arn }
output "queue_url" { value = aws_sqs_queue.limit_events.id }
output "queue_arn" { value = aws_sqs_queue.limit_events.arn }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
