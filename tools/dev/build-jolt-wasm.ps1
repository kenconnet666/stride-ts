# 用 Emscripten 把 Jolt 的 UnitTests 编成多线程加 SIMD 的 wasm，并在 Node 里运行。
# Jolt 自带的 Build/cmake_linux_emscripten.sh 只出单线程版；我们只发布 pthread 版，
# 所以这里通过编译和链接参数加上线程。
param(
    [ValidateSet('Debug', 'Release', 'Distribution')]
    [string] $Config = 'Distribution',
    # 默认取和本仓库并列的 JoltPhysics 目录
    [string] $JoltDir = (Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent) 'JoltPhysics'),
    [string] $Emsdk = ($env:EMSDK ?? (Join-Path $HOME 'emsdk'))
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $Emsdk 'emsdk_env.ps1') *> $null
# 系统里没装 CMake 和 Ninja，用 CLion 自带的。
$clionBin = Join-Path $env:LOCALAPPDATA 'Programs\CLion\bin'
$env:PATH = "$clionBin\cmake\win\x64\bin;$clionBin\ninja\win\x64;$env:PATH"

# Jolt 的 Build/.gitignore 已经忽略 WASM_* 目录。
$buildDir = Join-Path $JoltDir "Build\WASM_$Config"
$toolchain = Join-Path $Emsdk 'upstream\emscripten\cmake\Modules\Platform\Emscripten.cmake'

# Jolt 默认开（核数 - 1）个工作线程，而且是同步创建的，所以 Worker 池必须预先开好
# 至少这么多个，否则主线程会死锁。
cmake -S (Join-Path $JoltDir 'Build') -B $buildDir -G Ninja `
    "-DCMAKE_BUILD_TYPE=$Config" "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    -DUSE_WASM_SIMD=ON -DCMAKE_CXX_FLAGS=-pthread `
    '-DCMAKE_EXE_LINKER_FLAGS=-pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency' `
    -DTARGET_HELLO_WORLD=OFF -DTARGET_PERFORMANCE_TEST=OFF
cmake --build $buildDir --target UnitTests
node (Join-Path $buildDir 'UnitTests.js')
