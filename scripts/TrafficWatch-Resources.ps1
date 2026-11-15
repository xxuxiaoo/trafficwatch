$ErrorActionPreference='Stop'
try{
  $resourceCpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
  $resourceMemory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $resourceDisk=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  $resourceAdapters=@(Get-NetAdapterStatistics -ErrorAction SilentlyContinue|Select-Object Name,ReceivedBytes,SentBytes,ReceivedPacketErrors,OutboundPacketErrors)
  $resourceProcesses=@(Get-Process -Name 'node','magpie*','codex','claude','dsh','cc-switch','mihomo*','clash-verge','TrafficWatch*' -ErrorAction SilentlyContinue|ForEach-Object {@{pid=$_.Id;name=$_.ProcessName;cpuSeconds=$_.CPU;workingSetBytes=$_.WorkingSet64}})
  @{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();systemCpuPercent=$resourceCpu.PercentProcessorTime;availableMemoryMB=$resourceMemory.AvailableMBytes;diskQueueLength=$resourceDisk.CurrentDiskQueueLength;diskBytesPerSecond=$resourceDisk.DiskBytesPersec;adapters=$resourceAdapters;processes=$resourceProcesses}|ConvertTo-Json -Depth 5 -Compress
}catch{@{unavailable=$true}|ConvertTo-Json -Compress;exit 1}
