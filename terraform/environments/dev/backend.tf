terraform {
  backend "s3" {
    key          = "acme-credit/dev/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
