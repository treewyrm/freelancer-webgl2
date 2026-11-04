/**
 * Capture gating and the JSONL writer.
 *
 * One line per event, appended to a single file, flushed at frame end. JSONL rather than a binary
 * dump because the consumer is a TypeScript parser on the host and the point of the exercise is a
 * numeric diff against the viewer's own sprite output — a format anyone can read with `tail` while
 * the game is still running is worth more here than a compact one.
 *
 * Capture is gated on a keypress polled at Present, arming the *next* N frames. N rather than 1
 * because the once-at-birth question in EXP-02 is a question about consecutive frames.
 */
#pragma once

#include <windows.h>

namespace log8 {

struct Config {
    char file[MAX_PATH];  // output path, relative to the game directory
    int key;              // virtual-key code that arms a capture
    int frames;           // frames captured per press
    int vertsMax;         // dump vertex data only for draws at or under this vertex count
    bool matrices;        // include world/view/projection with every draw
    bool allDraws;        // log every draw, not just those carrying a vertex dump
};

const Config& config();

void init();
void shutdown();

/** Whether the frame currently being built is being captured. */
bool armed();

/** Called from Present: polls the key, closes the frame, advances the counter. True when that
 *  frame was the last of a capture. */
bool framePresented(unsigned draws);

unsigned frameIndex();

/** A path beside the game executable. */
void resolve(char* buffer, size_t size, const char* name);

/** Appends to the line under construction. */
void put(const char* format, ...);

/** Ends the line and writes it. */
void endLine();

/** Escapes and appends a JSON string value, quotes included. */
void putString(const char* value);

void flush();

}  // namespace log8
