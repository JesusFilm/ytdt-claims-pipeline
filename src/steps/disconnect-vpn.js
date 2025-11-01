const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);


async function disconnectVPN(context) {
  
  if (context.connections.mysql) {
    await context.connections.mysql.end();
    console.log('MySQL connection closed');
  }

  // Only kill OpenVPN if we spawned it 
  const skipVpn = ['true', '1'].includes(process.env.SKIP_VPN);
  if (!skipVpn) {
    if (context.connections.vpnProcess) {
      context.connections.vpnProcess.kill();
    }

    // Kill any remaining openvpn processes
    try {
      await execAsync('pkill -f openvpn');
    } catch (e) {
      // Ignore errors
    }

    console.log('VPN disconnected');
  } else {
    console.log('Passthrough mode - no VPN process to disconnect');
  }
}

module.exports = disconnectVPN;