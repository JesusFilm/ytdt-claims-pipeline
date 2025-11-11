async function disconnectVPN(context) {
  if (context.connections.mysql) {
    await context.connections.mysql.end();
    console.log('MySQL connection closed');
  }

  // Only kill OpenVPN if we spawned it
  const skipVpn = ['true', '1'].includes(process.env.SKIP_VPN);
  if (!skipVpn && context.connections.vpnProcess) {
    context.connections.vpnProcess.kill('SIGTERM');
    console.log('VPN disconnected');
  } else {
    console.log('Passthrough mode - no VPN process to disconnect');
  }
}

module.exports = disconnectVPN;
