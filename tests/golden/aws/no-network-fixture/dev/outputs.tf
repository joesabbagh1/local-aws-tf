# ============================================================================
# Compiled Terraform Outputs
# ============================================================================

output "web_instance_id" {
  description = "EC2 Instance ID (web)"
  value       = aws_instance.web.id
}

output "web_private_ip" {
  description = "Private IPv4 address (web)"
  value       = aws_instance.web.private_ip
}

output "worker_instance_id" {
  description = "EC2 Instance ID (worker)"
  value       = aws_instance.worker.id
}

output "worker_private_ip" {
  description = "Private IPv4 address (worker)"
  value       = aws_instance.worker.private_ip
}

output "pinned_instance_id" {
  description = "EC2 Instance ID (pinned)"
  value       = aws_instance.pinned.id
}

output "pinned_private_ip" {
  description = "Private IPv4 address (pinned)"
  value       = aws_instance.pinned.private_ip
}

output "fleet_asg_arn" {
  description = "ARN of the Auto Scaling Group (fleet)"
  value       = aws_autoscaling_group.fleet.arn
}

output "edge_alb_dns_name" {
  description = "DNS name of the load balancer (edge)"
  value       = aws_lb.edge.dns_name
}

output "edge_alb_arn" {
  description = "ARN of the load balancer (edge)"
  value       = aws_lb.edge.arn
}
