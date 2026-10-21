variable "name" { type = string }
variable "cidr" {
  type    = string
  default = "10.0.0.0/16"
}
variable "az_count" {
  type    = number
  default = 2
}
variable "single_nat_gateway" {
  type    = bool
  default = true
}
variable "enable_vpc_endpoints" {
  type    = bool
  default = true
}
