cmake_minimum_required(VERSION 3.22.1)
project(firesongvoice C)

add_library(firesongvoice SHARED voice_out.c)
target_compile_options(firesongvoice PRIVATE -Wall -Wextra -Werror -O2)
target_link_libraries(firesongvoice aaudio log)
