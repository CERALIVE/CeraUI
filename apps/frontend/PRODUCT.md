# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

No single person comes first. The app should be simple enough that anybody could use it, and powerful enough that even production professionals might be delighted using it.

## Product Purpose

This is CeraUI's browser app for controlling a CeraLive device (`apps/frontend/README.md:3`). It has three destinations: Live for streaming, Network for connectivity, and Settings for the system and device (`docs/ARCHITECTURE.md:39-45`).

## Operating Context

Today the app is built for local use, served from the device itself.

It's a responsive web UI with many breakpoints. For now, optimize for phone use first; that isn't a permanent ranking. Named screen contexts are phone, tablet, desktop and the 1024x600 kiosk touchscreen (`DESIGN.md:156-173`, `docs/TOUCHSCREEN.md:105-109`).

Cloud dashboard use today covers only three dialogs: Encoder, Audio and Server (`docs/agents/live-screen.md:743-745`, `docs/agents/federation-producer-pipeline.md:5-18`).

**FUTURE DIRECTION (not built today):** the same front-end container will also run in the cloud and connect to the device through a control channel (controls, not the camera picture), so the device can also be controlled from the cloud.

## Evidence on Hand

Evidence of real use exists privately and will be shared later. Don't invent usage.

## Product Principles

The overall bar: simple enough for anybody, powerful enough to delight production professionals. Alongside it are five promises:

1. **Status at a glance:** the operator sees whether they are live and healthy without hunting.
2. **Focused setup:** one clear task per screen or dialog.
3. **Truthful readings:** the app never shows a stale or guessed value as if it were current, and says plainly when it doesn't know.
4. **Every screen, every device:** every named screen works on every named device, including touch.
5. **Start or Stop** is always reachable.
