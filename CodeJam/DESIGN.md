---
version: alpha
name: "Agent Launchpad"
description: "A focused coding workbench with quiet paper surfaces, a dark utility rail, and restrained violet active states."
colors:
  ink: "#20211f"
  surface: "#fbfaf7"
  canvas: "#f2f1ed"
  primary: "#6954d9"
  success: "#33906d"
  danger: "#c55353"
  muted: "#777870"
typography:
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
  display:
    fontFamily: "ui-rounded, SF Pro Rounded, system-ui, sans-serif"
rounded:
  control: "10px"
  panel: "14px"
spacing:
  compact: "8px"
  panel: "20px"
components:
  playground:
    surface: "var(--paper)"
    border: "1px solid var(--line)"
---

# Agent Launchpad Design System

## Overview

Agent Launchpad is an operational coding workbench for hackathon builders. It
should feel like a sturdy field notebook: quiet warm paper surfaces, a dark
utility sidebar, and restrained violet for active work. The product is a tool,
not a marketing page, so familiar controls and readable status copy take
priority over decoration.

The existing CSS variables in `apps/web/src/styles.css` are the runtime source
of truth. This file records their semantic roles and intent; it does not
generate tokens.

## Colors

Use violet only for active controls and connection state. Green and red are
semantic status colors and must be paired with text or an icon. Keep contrast
strong on the dark sidebar and warm paper workspace. Focus states remain
visible independently of color.

## Typography

Use the system sans stack for body and data text. Reserve rounded system display
type for section headings when the existing stylesheet provides it. Setup and
error messages use plain language, sentence case, and the same action wording
through the workflow.

## Layout

The stable shell is a dark sidebar plus one paper workspace. Runtime/provider
health belongs in the sidebar card and the configuration warning belongs at the
top of the workspace. Provider setup copy should identify the single required
credential and distinguish it from optional model defaults.

When the deterministic fixture profile is active, a warm inline notice labels
the workspace as proof-only and points coding work to the Codex-backed Runtime.

Run activity belongs directly beneath the proof action. It is a compact,
timestamped activity rail: one current phase, recent safe summaries of Agent
work, and a visible stop action while a Run is active. This is the primary
feedback pattern for long-running or model-backed work; a spinner alone is not
enough.

## Elevation & Shapes

Use the existing paper panels, subtle shadows, 10px control radius, and 14px
panel radius. Do not create a new card family for provider status. Preserve
keyboard focus, responsive wrapping, and reduced-motion behavior from the
existing stylesheet.

## Components

Buttons use the existing emphasis and semantic status styles. Loading keeps the
button footprint stable. Runtime state is communicated with text as well as
color, and configuration failures explain the correction: set `GROQ_API_KEY`;
`GROQ_MODEL` is optional and defaults to `openai/gpt-oss-120b`.

## Do's and Don'ts

- **Do:** Keep provider status concise and visible beside the runtime identity.
- **Do:** Show what the Agent is doing now, what happened recently, and when the
  last Runtime event arrived.
- **Do:** Make stalled work recoverable with a clear stop action and explain
  what the user can do next.
- **Do:** Reuse existing spacing, typography, focus, and button patterns.
- **Don't:** Display API keys, raw provider errors, or secret-bearing runtime output.
- **Don't:** Turn a small setup change into a separate provider dashboard.
