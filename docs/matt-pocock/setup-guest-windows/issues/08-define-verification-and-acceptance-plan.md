# Define the verification and acceptance plan

Type: grilling
Blocked by: 06, 07

## Question

What exact evidence must an implementation provide before `setup-guest-windows` is considered complete?

Define unit coverage for the stable internal seams and failure states; CLI coverage for packaged help, options, prompts, preflight, and secret handling; and a guest-tier scenario that invokes the packaged command from the setup phase, runs the real Windows pre-isolation steps, crosses onto the real Internal switch, runs the real post-isolation steps, and verifies the resulting isolated guest. Account explicitly for the current Windows golden image's preinstalled Git substitution, the optional ISO prerequisite, two masked password inputs, long-running package installation, and diagnostics on failure. The guest-tier run must record whether any supported installer requested a reboot, because that evidence alone would trigger the controlled-reboot extension in [Define end-to-end orchestration and recovery](06-define-orchestration-and-recovery.md). Decide how replay from the orchestration ticket's residual states and its residual-state footer are covered.

Also define the required documentation changes and an acceptance checklist linking each observable promise from the command and orchestration decisions to one highest-appropriate test tier. Do not implement the tests or command in this ticket.
