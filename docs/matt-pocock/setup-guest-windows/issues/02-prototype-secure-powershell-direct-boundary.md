# Prototype the secure PowerShell Direct boundary

Type: prototype
Status: claimed
Blocked by: 01

## Question

What production boundary should execute PowerShell inside the named guest through PowerShell Direct using the prompted local-administrator credential?

Build only enough throwaway code and tests to compare viable invocation shapes. The chosen shape must not expose the plaintext password in process arguments, logs, errors, durable host files, or durable guest files; must safely carry arbitrary UTF-8 scripts without nested-quoting failures; and must return trustworthy stdout, stderr, and exit status with bounded waits, cancellation, and useful errors while the VM starts and restarts.

Use the existing guest-harness `WindowsGuestExec` and its PowerShell 5.1 module-path workaround as evidence, not automatically as the production interface. Record the selected credential lifecycle, script transport, readiness probe, timeout behavior, cleanup guarantees, and interface that later orchestration can depend on. Link the prototype asset from the answer rather than treating it as production code.
