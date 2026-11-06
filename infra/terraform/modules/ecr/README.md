# ecr

Image repository with **IMMUTABLE** tags, scan on push and KMS encryption. Lifecycle rules expire untagged images
after `untagged_expiry_days` and keep the latest `keep_tagged_images` tagged images (the rollback depth). Deploy by
digest (`repo@sha256:...`) and promote the same digest dev → staging → prod.
