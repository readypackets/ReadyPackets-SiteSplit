# Diagram Validation Notes

Validated August 2026.

- `mobile-system-architecture.png` rendered successfully from Mermaid and was visually reviewed after layout refinement. It shows the intended trust boundaries: native iOS/Android clients, Cloudflare/nginx edge, versioned mobile API, existing backend/data, and constrained providers. The expanded horizontal canvas preserves readable node labels without clipping.
- `mobile-auth-sequence.mmd` and `mobile-release-pipeline.mmd` rendered successfully after removing a Mermaid-incompatible semicolon from one sequence message.
- Mermaid source files remain the authoritative editable diagrams. PNG exports are provided for convenient viewing in the architecture document.
