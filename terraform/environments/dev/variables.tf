variable "region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type    = string
  default = "dev"
}
variable "image_tag" {
  type        = string
  description = "Tag of the lending and collateral images pushed to ECR."
}
variable "certificate_arn" {
  type        = string
  default     = null
  description = "ACM certificate for the public load balancer. Without it the listener is plain HTTP, only acceptable for throwaway environments."
}
variable "public_ingress_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}
variable "auth_issuer" {
  type    = string
  default = "https://idp.example.com"
}
variable "auth_audience" {
  type    = string
  default = "acme-credit"
}
variable "multi_az" {
  type    = bool
  default = false
}
variable "deletion_protection" {
  type    = bool
  default = false
}
