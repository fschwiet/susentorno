# Choose the production module boundaries

Type: grilling
Blocked by: 06

## Question

Where should the Windows setup path share production modules with `setup-guest-unix`, and where should it remain an honest Windows-specific sibling?

Using the settled command, PowerShell Direct, script, trust, share, and orchestration contracts, assign responsibilities and stable interfaces across the command registration, prompt resolution, host-network preflight, VM reconciliation, guest execution, share access, script running, and ambient-trust modules. Decide which proven guest-harness code graduates into `src/`, which Unix modules become platform-neutral without weakening their interfaces, and which apparent similarities should remain duplicated because their semantics differ.

The answer should be a file/module-level implementation outline that minimizes conditional platform branches, preserves current Unix behavior, and leaves seams that the agreed test tiers can exercise directly.
