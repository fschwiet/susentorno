# Define shipped Windows step compatibility changes

Type: grilling

## Question

What exact changes must the shipped Windows pre-isolation and post-isolation steps make to satisfy the settled Windows script-runner contract and run reliably through noninteractive PowerShell Direct sessions?

Audit every shipped `.ps1` step for native commands whose nonzero status is currently ignored, accepted idempotent native outcomes that must remain successful, fresh-process PATH and environment propagation, package-manager readiness, reboot requirements, interactivity, and execution from a read-only UNC VM share. Decide the required script and documentation adaptations without implementing them.

Account for the ambient-trust design before finalizing changes to `configure-network`. The answer must distinguish genuine provisioning failures from explicitly accepted idempotent outcomes and identify any prerequisite checks or reboot boundaries that end-to-end orchestration must provide.
