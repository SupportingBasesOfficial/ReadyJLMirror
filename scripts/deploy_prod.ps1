$cmds = @"
cd /opt/argos && sudo git pull origin main && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db psql -U jlmirror_owner -d jlmirror < /opt/argos/sql/monitoring/029_validation_evidence_unique.sql && echo MIGRATION_029_OK && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db psql -U jlmirror_owner -d jlmirror < /opt/argos/sql/monitoring/030_gap_evidence_idempotent.sql && echo MIGRATION_030_OK && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml restart worker && echo WORKER_RESTARTED
"@
$cmds | ssh debian@200.187.67.114
