@echo off
REM Deploy Lion Meet to AWS EC2 (Windows)
REM Requires: OpenSSH client, lion.pem in project root

set EC2_HOST=3.34.197.18
set EC2_USER=ubuntu
set KEY_FILE=%~dp0..\lion.pem

echo === Deploying Lion Meet to %EC2_HOST% ===

scp -i "%KEY_FILE%" -r "%~dp0..\config" "%~dp0..\meetings" "%~dp0..\static" "%~dp0..\deploy" "%~dp0..\manage.py" "%~dp0..\requirements.txt" %EC2_USER%@%EC2_HOST%:/tmp/lion_meet_upload/

if exist "%~dp0..\.env" (
  scp -i "%KEY_FILE%" "%~dp0..\.env" %EC2_USER%@%EC2_HOST%:/tmp/lion_meet_upload/.env
)

ssh -i "%KEY_FILE%" %EC2_USER%@%EC2_HOST% "bash /tmp/lion_meet_upload/deploy/setup_ec2.sh"

echo.
echo Done! Visit https://3-34-197-18.sslip.io/
