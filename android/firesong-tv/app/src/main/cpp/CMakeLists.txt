cmake_minimum_required(VERSION 3.22.1)
project(firesongvoice C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_library(firesongvoice SHARED
  engine.c
  aaudio_out.c
  jni_mics.c
  dsp/biquad.c
  dsp/gate.c
  dsp/compressor.c
  dsp/echo.c
  dsp/reverb.c
  dsp/fft.c
  dsp/guard.c
  dsp/level.c
  dsp/goertzel.c)
target_include_directories(firesongvoice PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_options(firesongvoice PRIVATE -Wall -Wextra -Werror -O2)
target_link_libraries(firesongvoice aaudio log m)
