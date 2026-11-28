cmake_minimum_required(VERSION 3.24)
project(council_handoff_feasibility VERSION 0.1.0 LANGUAGES CXX)

# This is an explicit build-only feasibility package, not a service installer.
if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_CXX_COMPILER_ID STREQUAL "MSVC")
  message(FATAL_ERROR "Use the pinned Microsoft Windows ARM64 toolchain.")
endif()
if(NOT CMAKE_CXX_COMPILER_VERSION VERSION_EQUAL "19.44.35228.0")
  message(FATAL_ERROR "Expected MSVC compiler 19.44.35228.0.")
endif()
if(NOT "$ENV{WindowsSDKVersion}" MATCHES "^10\\.0\\.26100\\.0\\\\?$")
  message(FATAL_ERROR "Expected Windows SDK 10.0.26100.0.")
endif()

add_executable(council-handoff-probe src/probe.cpp)
target_compile_features(council-handoff-probe PRIVATE cxx_std_20)
target_compile_options(council-handoff-probe PRIVATE /W4 /WX /sdl /guard:cf /Brepro)
target_link_options(council-handoff-probe PRIVATE /guard:cf /Brepro /DYNAMICBASE /NXCOMPAT)
set_property(TARGET council-handoff-probe PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")

file(WRITE "${CMAKE_BINARY_DIR}/build-info.json"
  "{\"schema\":\"council.synthetic-build/v1\",\"compiler\":\"msvc\",\"compilerVersion\":\"${CMAKE_CXX_COMPILER_VERSION}\",\"windowsSdkVersion\":\"10.0.26100.0\",\"target\":\"windows-arm64\"}\n")
