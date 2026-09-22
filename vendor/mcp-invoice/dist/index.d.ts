#!/usr/bin/env node
/**
 * D-R60. Every server that imports readSharedProfile, other than invoice itself, in the
 * order `grep -rl readSharedProfile servers/*\/src` returns them. test/profile-readers.test.mjs
 * re-runs that grep and fails if this list ever drifts from it, so a server that starts (or
 * stops) reading the shared profile cannot go unnoticed here again.
 */
export declare const PROFILE_READERS: string[];
