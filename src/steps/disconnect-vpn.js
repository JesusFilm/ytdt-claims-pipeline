import { env } from '../env.js'

export default async function disconnectVPN(context) {
  if (context.connections.mysql) {
    await context.connections.mysql.end()
    console.log('MySQL connection closed')
  }

  // Only kill OpenVPN if we spawned it
  const skipVpn = env.SKIP_VPN
  if (!skipVpn && context.connections.vpnProcess) {
    context.connections.vpnProcess.kill('SIGTERM')
    console.log('VPN disconnected')
  } else {
    console.log('Passthrough mode - no VPN process to disconnect')
  }
}
