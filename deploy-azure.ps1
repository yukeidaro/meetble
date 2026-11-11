# Deploy the Meetble server to a small Azure VM. Run it yourself in PowerShell (5 or 7) from the repo folder:
#   .\deploy-azure.ps1
# Needs: Azure CLI signed in (az login) with the subscription you want selected (az account set -s "<name>"),
# plus .env (and optionally user_profile.json) in this folder. Keys are copied straight to the VM over SSH,
# never into the repo. The browser steps (LinkedIn, Luma in your Chrome) stay off on a server.
# Delete everything afterwards:  az group delete -n meetble-rg --yes
param(
  [string]$Group = "meetble-rg",
  [string]$Name = "meetble-vm",
  [string]$Location = "eastasia",
  [string]$Size = "Standard_B2s"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path ".env")) { throw ".env not found. Run this from the meetble folder." }

Write-Host "Subscription:" (az account show --query name -o tsv)
az group create -n $Group -l $Location -o none
Write-Host "Creating the VM (2-3 minutes)..."
$ip = az vm create -g $Group -n $Name --image Ubuntu2204 --size $Size --admin-username azureuser `
  --generate-ssh-keys --public-ip-sku Standard --query publicIpAddress -o tsv
if (-not $ip) { throw "VM creation returned no IP. Try -Location japaneast or -Size Standard_B2ms." }
az vm open-port -g $Group -n $Name --port 8787 -o none
Write-Host "VM IP: $ip"

$ssh = @("-o", "StrictHostKeyChecking=accept-new", "azureuser@$ip")
ssh @ssh "curl -fsSL https://raw.githubusercontent.com/yukeidaro/meetble/main/setup-gmi.sh | bash"
scp -o StrictHostKeyChecking=accept-new .env "azureuser@${ip}:~/meetble/.env"
if (Test-Path "user_profile.json") { scp -o StrictHostKeyChecking=accept-new user_profile.json "azureuser@${ip}:~/meetble/user_profile.json" }
ssh @ssh "cd ~/meetble && (nohup ./start-gmi.sh > server.log 2>&1 &) && sleep 3 && cat server.log"
$token = ssh @ssh "cat ~/meetble/.meetble_token"
Write-Host ""
Write-Host "Open: http://${ip}:8787/?token=$token"
Write-Host "Health: curl.exe -s http://${ip}:8787/api/health"
Write-Host "Delete when done: az group delete -n $Group --yes"
