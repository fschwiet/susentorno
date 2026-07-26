# Customize guest home configuration with declarative jq transforms

Guest home JSON settings are customized by an ordered manifest of jq transforms that a single TypeScript applier runs on both Ubuntu and Windows. This centralizes merge semantics, preserves unrelated user settings, and keeps platform wrappers thin, accepting jq as a guest prerequisite in exchange for avoiding duplicated shell and PowerShell implementations.
