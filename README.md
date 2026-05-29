# Detener el proceso en 3000
$listenerPid = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if ($listenerPid) { Stop-Process -Id $listenerPid -Force }

# Iniciar con tu IP LAN
cd "C:\Users\ASUS\Documents\ICESI\Exploracion\LoboCastronegro"
$env:HOST_IP="Aqui pones tu IPV4 que podes ver en las propiedades del wifi"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm start