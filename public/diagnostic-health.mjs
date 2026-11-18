const reasons={
  physical_adapter_unavailable:'没有找到可用物理网卡',physical_adapter_changed:'物理网卡或网关已变化，需要重新应用',physical_dns_unavailable:'物理网卡 DNS 解析未完成',relay_resolution_incomplete:'部分中转未解析出可用地址',relay_route_verification_failed:'中转路由没有全部指向物理网卡',relay_routes_failed:'Windows 路由检查失败',administrator_required:'路由后台缺少管理员权限',managed_hosts_modified:'受管 hosts 条目被外部修改',existing_hosts_conflict:'已有 hosts 条目与中转配置冲突',relay_targets_changed:'中转列表已更改，正在重新应用',relay_rollback_failed:'恢复原有路由失败',
  clash_controller_unavailable:'未连接到当前代理内核的控制接口',clash_controller_unauthorized:'代理控制接口授权失败',clash_multiple_active_tun:'同时发现多个启用的虚拟网卡内核，无法安全选择',clash_client_unsupported:'当前代理客户端尚无安全配置适配',clash_config_identity_mismatch:'运行内核与配置文件不匹配，已停止写入',clash_profile_script_not_configured:'Verge 的持久绕行脚本未配置',clash_profile_script_unsupported:'Verge 的绕行脚本格式不兼容',clash_dns_filter_unsupported:'当前 DNS 筛选模式不能安全合并绕行规则',controller_timeout:'代理控制接口响应超时',controller_invalid:'代理控制接口返回内容异常',controller_oversize:'代理控制接口返回内容过大',controller_http_401:'代理控制接口密码不匹配（401）',controller_http_403:'代理控制接口拒绝访问（403）',controller_http_404:'代理控制接口地址不兼容（404）',controller_http_400:'代理内核拒绝配置（400）',controller_http_500:'代理内核应用配置失败（500）',relay_access_denied:'后台访问配置或控制接口被拒绝',
  flclash_controller_disabled:'FlClash 未开启外部控制接口，无法读取它的连接或验证排除规则',flclash_controller_unavailable:'FlClash 正在接管网络，但它的控制接口不可达',route_not_physical:'路由未指向物理网卡',system_dns_mismatch:'系统 DNS 与物理解析地址不一致',physical_probe_failed:'物理网卡直连探测未完成',probe_source_mismatch:'探测连接未使用预期物理网卡',clash_observation_unavailable:'未能检查代理内核中的连接',relay_connections_still_in_clash:'仍发现中转连接经过代理内核',ipv6_unmanaged:'存在尚未纳入物理绕行的 IPv6 地址',target_validation_incomplete:'目标验证证据不完整',bypass_validation_failed:'验证发生异常，等待下一次复查'
};
const stageNames={adapter:'物理网卡',dns:'DNS 解析',routes:'Windows 路由',controller:'代理控制接口',overlay:'代理排除规则',probe:'直连探测',connections:'连接核验'};
reasons.ordinary_path_unverified='普通应用连接尚未通过物理直连验证';
const clientNames={verge:'Clash Verge',flclash:'FlClash',mihomo:'Mihomo'};
export function diagnosticHealth(value={}){
  if(value.liveAvailable===false)return {collector:{tone:'neutral',title:'按授权查看历史',detail:'访客卡未授予实时采集状态'},bypass:{tone:'neutral',title:'实时信息未授权',detail:'可查看访客卡日期内的诊断记录',reasons:[]}};
  const state=value.collector,recording=state?.state==='recording',systemOk=state?.trace==='recording'&&state?.pktmon==='recording';
  const collector={tone:recording?(systemOk?'good':'warn'):'bad',title:recording?(systemOk?'正在持续取证':'取证运行中 · 部分来源异常'):'诊断后台未运行',detail:recording?(systemOk?'日志、TCP 和 PktMon 正常记录':'请展开“采集完整性”查看缺少的来源'):'历史仍可查询；可从桌面控制台启动诊断'};
  const path=value.bypass||{},checking=path.state==='checking',effective=checking?path.previousState:path.state;
  const tone=effective==='verified'?'good':effective==='degraded'?'bad':['stale','route_checked','checking'].includes(path.state)?'warn':'neutral';
  let title=({verified:'物理绕行已验证',degraded:'部分验证未通过',stale:'需重新验证',route_checked:'路由已检查，等待连接验证',rolled_back:'已恢复原 DIRECT 路径',stopped:'物理绕行检查已停止'}[effective])||(checking?'正在验证物理路径':'尚未启用 / 无状态');
  if(checking&&['verified','degraded'].includes(effective))title+=' · 复查中';
  const failures=(path.failures||[]).map(item=>({code:item.code,text:(reasons[item.code]||reasons.bypass_validation_failed)+(item.count>1?`（${item.count} 项）`:'')}));
  if(path.error&&!failures.some(item=>item.code===path.error))failures.unshift({code:path.error,text:reasons[path.error]||reasons.bypass_validation_failed});
  let detail=failures[0]?.text||(effective==='verified'?`${Number.isSafeInteger(path.verified)?path.verified+' / '+path.targets+' 个中转通过验证':'路由、DNS、物理网卡与代理连接检查通过'}`:checking?`正在检查${stageNames[path.stage]||'物理路径'}`:'查看“中转直连”可管理目标并重新检查');
  if(path.client)detail=clientNames[path.client]+' · '+detail;
  return {collector,bypass:{tone,title,detail,reasons:failures.map(item=>item.text),stage:stageNames[path.stage],at:path.at,checkedAt:path.checkedAt,lastVerifiedAt:path.lastVerifiedAt}};
}
