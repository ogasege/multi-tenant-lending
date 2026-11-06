resource "aws_ecr_repository" "this" {
  name = var.repository_name

  # Immutable tags: "v1.4.2" can never silently point at different bytes,
  # so what was tested in staging is exactly what runs in prod. Deploys
  # reference the digest anyway; immutability protects humans reading tags.
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_delete

  # Basic scan on push catches known CVEs in OS packages before deploy.
  # (Enhanced/Inspector scanning is an account-level setting.)
  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

# Storage costs grow silently on every CI build; keep a bounded
# rollback window and drop dangling layers quickly.
resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after ${var.untagged_expiry_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_expiry_days
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the ${var.keep_tagged_images} most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = var.keep_tagged_images
        }
        action = { type = "expire" }
      },
    ]
  })
}
