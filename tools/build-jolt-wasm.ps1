# Builds Jolt's UnitTests to multithreaded SIMD wasm with Emscripten and runs them under Node.
# Jolt's own Build/cmake_linux_emscripten.sh only produces single-threaded wasm; we ship the
# pthread build only, so threads are added here through the compiler and linker flags.
param(
    [ValidateSet('Debug', 'Release', 'Distribution')]
    [string] $Config = 'Distribution',
    [string] $JoltDir = 'C:\Users\Administrator\CLionProjects\jolt-native-fork',
    [string] $Emsdk = 'C:\Users\Administrator\emsdk'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $Emsdk 'emsdk_env.ps1') *> $null
# CMake and Ninja are not installed system-wide; use the copies bundled with CLion.
$clionBin = Join-Path $env:LOCALAPPDATA 'Programs\CLion\bin'
$env:PATH = "$clionBin\cmake\win\x64\bin;$clionBin\ninja\win\x64;$env:PATH"

# Jolt's Build/.gitignore ignores WASM_* folders.
$buildDir = Join-Path $JoltDir "Build\WASM_$Config"
$toolchain = Join-Path $Emsdk 'upstream\emscripten\cmake\Modules\Platform\Emscripten.cmake'

# Jolt starts (cores - 1) workers by default and creates them synchronously, so the Worker
# pool must be preloaded with at least that many; otherwise the main thread deadlocks.
cmake -S (Join-Path $JoltDir 'Build') -B $buildDir -G Ninja `
    "-DCMAKE_BUILD_TYPE=$Config" "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    -DUSE_WASM_SIMD=ON -DCMAKE_CXX_FLAGS=-pthread `
    '-DCMAKE_EXE_LINKER_FLAGS=-pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency' `
    -DTARGET_HELLO_WORLD=OFF -DTARGET_PERFORMANCE_TEST=OFF
cmake --build $buildDir --target UnitTests
node (Join-Path $buildDir 'UnitTests.js')
