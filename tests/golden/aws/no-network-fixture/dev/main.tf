# ============================================================================
# LocalCloud Studio — Compiled Terraform Infrastructure (DEVELOPMENT)
# Target Mode: AWS (us-east-1)
# Active Resources: 5 | Wired Connections: 0
# ============================================================================

locals {
  environment = var.environment
  name_prefix = "lc-${var.environment}"
  common_tags = merge(var.default_tags, {
    Environment = var.environment
    Region      = var.aws_region
    Compiler    = "LocalCloud-Studio-2D"
  })
}

# Latest Amazon Linux 2023 image for this region (set an AMI on the node to pin one)
data "aws_ssm_parameter" "al2023_ami_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# Latest Amazon Linux 2023 image for this region (set an AMI on the node to pin one)
data "aws_ssm_parameter" "al2023_ami_x86_64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "web" {
  ami                         = data.aws_ssm_parameter.al2023_ami_x86_64.insecure_value
  instance_type               = "t3.micro"
  subnet_id                   = var.subnet_ids[0]
  vpc_security_group_ids      = []
  associate_public_ip_address = false
  monitoring                  = false

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-EOF
#!/bin/bash
echo "Bootstrapped by LocalCloud Studio"
  EOF

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-web"
  })
}

resource "aws_instance" "worker" {
  ami                         = data.aws_ssm_parameter.al2023_ami_arm64.insecure_value
  instance_type               = "t4g.small"
  subnet_id                   = var.subnet_ids[0]
  vpc_security_group_ids      = []
  associate_public_ip_address = false
  monitoring                  = false

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-EOF
#!/bin/bash
echo "Bootstrapped by LocalCloud Studio"
  EOF

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-worker"
  })
}

resource "aws_instance" "pinned" {
  ami                         = "ami-0abcdef1234567890"
  instance_type               = "t3.micro"
  subnet_id                   = var.subnet_ids[0]
  vpc_security_group_ids      = []
  associate_public_ip_address = false
  monitoring                  = false

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = <<-EOF
#!/bin/bash
echo "Bootstrapped by LocalCloud Studio"
  EOF

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-pinned"
  })
}

resource "aws_launch_template" "fleet_lt" {
  name_prefix   = "${local.name_prefix}-fleet-"
  image_id      = data.aws_ssm_parameter.al2023_ami_x86_64.insecure_value
  instance_type = "t3.medium"
}

resource "aws_autoscaling_group" "fleet" {
  name                      = "${local.name_prefix}-fleet-asg"
  min_size                  = 1
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = var.subnet_ids
  health_check_type         = "ELB"
  health_check_grace_period = 300

  launch_template {
    id      = aws_launch_template.fleet_lt.id
    version = "$Latest"
  }
}

resource "aws_lb" "edge" {
  name                       = trimsuffix(substr("${local.name_prefix}-edge", 0, 32), "-")
  internal                   = false
  load_balancer_type         = "application"
  subnets                    = var.subnet_ids
  security_groups            = []
  enable_deletion_protection = false
  idle_timeout               = 60

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-edge"
  })
}

resource "aws_lb_target_group" "edge_tg" {
  name        = trimsuffix(substr("${local.name_prefix}-edge-tg", 0, 32), "-")
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_listener" "edge_listener" {
  load_balancer_arn = aws_lb.edge.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.edge_tg.arn
  }
}
