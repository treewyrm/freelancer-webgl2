# Cross-built on macOS: brew install mingw-w64
#
#   make            → build/d3d8.dll, a 32-bit Windows DLL
#   make install    → copies it and the default config beside the game
#                     FL=/Volumes/.../Freelancer/EXE make install
#
# Statically linked against libgcc and libstdc++ so the DLL drops into a game directory alone.
# Exceptions and RTTI are off: nothing here throws, and the smaller runtime is one less thing
# between the game and the log.

CXX      := i686-w64-mingw32-g++
WINDRES  := i686-w64-mingw32-windres

CXXFLAGS := -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -fno-exceptions -fno-rtti

LDFLAGS  := -shared -static -static-libgcc -static-libstdc++ \
            -Wl,--enable-stdcall-fixup

SOURCES  := src/main.cpp src/proxy.cpp src/log.cpp src/capture.cpp
OBJECTS  := $(SOURCES:src/%.cpp=build/%.o)
TARGET   := build/d3d8.dll

FL ?=

.PHONY: all clean install

all: $(TARGET)

$(TARGET): $(OBJECTS) d3d8log.def | build
	$(CXX) $(LDFLAGS) -o $@ $(OBJECTS) d3d8log.def
	@echo "built $@"

build/%.o: src/%.cpp | build
	$(CXX) $(CXXFLAGS) -c $< -o $@

build:
	@mkdir -p build

install: $(TARGET)
	@test -n "$(FL)" || (echo "set FL to the Freelancer EXE directory" && false)
	cp -X $(TARGET) "$(FL)/d3d8.dll"
	@test -f "$(FL)/d3d8log.ini" || cp -X d3d8log.ini "$(FL)/d3d8log.ini"
	@echo "installed to $(FL)"

clean:
	rm -rf build
