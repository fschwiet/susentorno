# `promptMasked` releases stdin explicitly

`setup-guest-unix` prompts for the SMB password and then spawns `ssh` with inherited stdio. Node's `emitKeypressEvents` leaves an internal data listener on the input stream, so removing the prompt's own listener and disabling raw mode does not stop Node from competing with the child for console input. `promptMasked` therefore calls `input.pause()` unconditionally on both submission and cancellation before it resolves or rejects.

## Considered Options

- **Adopt a general prompt library.** Rejected because the command and its tests require masked prompts to work with injected, non-TTY streams and piped input as well as an interactive Windows console. The evaluated terminal-oriented libraries did not preserve that contract, so replacing the local implementation would make this behavior less testable.

## Consequences

- The injectable `PromptStreams` interface remains the stable seam for unit and CLI automation.
- Unit tests verify that cleanup pauses input after both submission and cancellation. The handoff to a real inherited-console child remains an integration property of the Windows console rather than something an in-memory stream fully reproduces.
