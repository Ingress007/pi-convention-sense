/**
 * Source files above this size are not read or analyzed. They are almost always generated or data
 * files, and reading dozens of them (every peer candidate is analyzed) would stall the Pi event loop.
 * A target above the limit fails open as `analysis-error`; a peer above it is skipped.
 */
export const MAX_ANALYZED_FILE_BYTES = 1024 * 1024;
