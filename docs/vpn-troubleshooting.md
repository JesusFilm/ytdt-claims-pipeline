# VPN Troubleshooting

The pipeline connects to MySQL RDS through OpenVPN by spawning the `openvpn` binary directly (see `src/steps/connect-vpn.js`). The `.ovpn` file lives at `./config/vpn/client.ovpn` (gitignored).

## Rotating credentials

```bash
# from repo root, after dropping new client.ovpn into config/vpn/
gcloud compute scp config/vpn/client.ovpn ytdt-claims:/tmp/client.ovpn --zone=us-east1-b
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  sudo mv /tmp/client.ovpn /opt/ytdt-claims-pipeline/config/vpn/client.ovpn &&
  sudo chmod 600 /opt/ytdt-claims-pipeline/config/vpn/client.ovpn
"
```

No service restart needed — next pipeline run picks it up. Code spawns openvpn fresh each run.

## Required directives in client.ovpn

The Arclight VPN server pushes `redirect-gateway def1` (full tunnel) and uses `comp-lzo` compression. A bare `.ovpn` from the provider will need these additions to work on the GCP VM:

```
comp-lzo                                       # server pushes lzo compression
redirect-gateway def1                          # send public RDS traffic via VPN
route 10.142.0.0 255.255.240.0 net_gateway     # exclude GCP VPC from VPN
```

### Why each is needed

**`comp-lzo`** — server-side has it enabled. Without it locally, the tunnel comes up but `write to TUN/TAP : Invalid argument (code=22)` errors flood `logs/vpn.log` and packets get dropped.

**`redirect-gateway def1`** — RDS host is a public AWS hostname (`*.rds.amazonaws.com`) resolving to a public IP outside the pushed `10.0.0.0/16` route. Without full-tunnel, MySQL traffic exits via the local gateway and bypasses the VPN entirely → connection times out.

**`route 10.142.0.0 255.255.240.0 net_gateway`** — full-tunnel hijacks everything, including MongoDB at `10.142.0.62` (GCP VPC internal). `net_gateway` keeps GCP VPC traffic on `ens4`, away from the tunnel.

## Diagnostic commands

Live tunnel + routes:
```bash
gcloud compute ssh ytdt-claims --zone=us-east1-b --command="
  sudo tail -40 /opt/ytdt-claims-pipeline/logs/vpn.log
  echo '---ROUTES---'
  ip route
"
```

What to look for in `vpn.log`:
- `Initialization Sequence Completed` — tunnel is up
- `write to TUN/TAP : Invalid argument` — missing `comp-lzo`
- `WARNING: 'comp-lzo' is present in remote config but missing in local` — same
- `Options error: option 'route' cannot be used in this context` — caused by `route-nopull`; remove it

What to look for in `ip route` (when VPN is up):
- `default via 10.142.0.1 dev ens4` — should stay (Mongo path)
- `10.0.0.0/16 via 192.168.2.5 dev tun0` — RDS via VPN ✓
- `10.142.0.0/20 via 10.142.0.1` — VPC excluded from VPN ✓
- `0.0.0.0/1 via 192.168.2.5 dev tun0` — public traffic via VPN ✓

## Pipeline service

```bash
sudo systemctl status ytdt-claims-pipeline
sudo journalctl -u ytdt-claims-pipeline -f
```

Ignore `openvpn-client@client.service` and `openvpn.service` — the pipeline doesn't use them.