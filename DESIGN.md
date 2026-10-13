---
name: UMLith
description: A local architecture editor with PlantUML diagrams and contextual authoring.
colors:
  primary: "#ff3d00"
  background: "#0a0a0a"
  shell: "#111111"
  panel: "#171717"
  input: "#222222"
  border: "#3a3a3a"
  text: "#fafafa"
  secondary-text: "#d4d4d4"
  muted-text: "#a3a3a3"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  title:
    fontSize: "20px"
    fontWeight: 700
rounded:
  control: "3px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
---

# Design System: UMLith

## Overview

The shipped direction is a dense, dark architecture workbench. The diagram occupies the center; a model tree and contextual details support authoring. This record describes the implementation, not a completed visual acceptance review.

## Colors

Orange identifies active navigation, focused controls, selected diagram items, and primary actions. Neutral layers separate the shell, panels, and inputs. Save, failure, and warning states have text labels alongside their status colors.

## Typography

Use the system sans-serif stack for navigation, prose, and labels. Signatures and generated PlantUML source use monospace where available. Headings wrap long names; details expose full signatures rather than relying on hover.

## Layout

The canvas starts without side panels. A node or member selection opens Details; Model is optional. When opened, desktop uses a 232px model tree, flexible canvas, and 360px details panel. At 1280px, side panels narrow to 208px and 332px. At 1100px, show at most one side panel. Below 768px, side panels become dismissible overlays, the header wraps, and toolbars scroll horizontally. Keep canvas scrolling separate from details scrolling.

## Elevation & Depth

Neutral surface tones and one-pixel borders establish the main hierarchy. Shadows are reserved for floating menus and mobile side panels.

## Shapes

Controls use small corners. Navigation uses text and an active underline. Diagram boxes follow PlantUML notation; their shapes express UML and database semantics.

## Components

The header exposes Design, Build & review, saved state, and handoff. Design views share one graph: Overview, Classes, Database, with optional method flows. Creation lives in compact menus opened by plus controls beside diagram nodes and members, or the empty-canvas Add action. The sidebar edits only the selected item. Save and Discard are available above the canvas and in contextual details. The PlantUML toolbar provides zoom, fit, source inspection, and source/SVG downloads. Methods, fields, and relationships carry stable selection links in rendered SVG.

## Do's and Don'ts

- Do preserve black/neutral surfaces and the orange identity accent.
- Do provide visible keyboard focus, text status, and list/form alternatives to diagram interaction.
- Do retain semantic drafts across view changes and keep layout changes separate from semantic revisions.
- Don't present generated diagrams, source analysis, or a build success as proof of behavior.
- Don't make optional method flowcharts a prerequisite for a handoff.
