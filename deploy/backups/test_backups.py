#!/usr/bin/env python3
"""Local control-flow fixtures: fake Docker/GNU tools, no daemon or provider required."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
env = os.environ
if name == 'stat':
    mode = oct(pathlib.Path(args[-1]).stat().st_mode & 0o777)[2:]
    print(('1000' if env.get('BAD_OWNER') else '0') + ':' + mode)
elif name == 'flock':
    sys.exit(75 if env.get('LOCK_BUSY') else 1 if env.get('LOCK_FAIL') else 0)
elif name == 'timeout':
    while args and args[0].startswith('--'):
        args.pop(0)
    duration = args.pop(0)
    assert duration.endswith('s') and int(duration[:-1]) <= 2800
    deadline = .15 if env.get('TIMEOUT_EXEC') and 'exec' in args else 5
    try:
        sys.exit(subprocess.run(args, timeout=deadline).returncode)
    except subprocess.TimeoutExpired:
        sys.exit(124)
elif name == 'df':
    print('Filesystem 1024-blocks Used Available Capacity Mounted on')
    available = int(env.get('DISK_FREE', '20'))
    print('fixture 100 ' + str(100-available) + ' ' + str(available) + ' 80% /fixture')
elif name == 'docker':
    with open(env['DOCKER_LOG'], 'a') as f:
        f.write(json.dumps(args) + '\n')
    if args[0] == 'ps':
        if env.get('FAIL_PS'):
            print('a'*64)
            print('secret-fixture-marker', file=sys.stderr)
            sys.exit(9)
        inventory = [('a'*64,'production-uuid','postgres','running'),
                     ('b'*64,'staging-uuid','postgres','running'),
                     ('c'*64,'production-uuid','worker','running'),
                     ('d'*64,'production-uuid','postgres','exited')]
        if env.get('DUPLICATE'):
            inventory.append(('e'*64,'production-uuid',env['DUPLICATE'],'running'))
        filters = [args[i+1] for i,a in enumerate(args) if a == '--filter']
        assert 'status=running' in filters
        for ident, project, service, status in inventory:
            expected = ['status='+status,'label=com.docker.compose.project='+project,
                        'label=com.docker.compose.service='+service]
            if all(f in expected for f in filters):
                print(ident)
    elif args[0] == 'exec':
        assert '--user' in args and 'timeout' in args
        if env.get('TIMEOUT_EXEC'):
            time.sleep(2)
        if env.get('FAIL_EXEC'):
            print('secret-fixture-marker')
            print('secret-fixture-marker', file=sys.stderr)
            sys.exit(9)
        if 'info' in args:
            if env.get('BAD_JSON'):
                print('secret-fixture-marker')
            else:
                now = int(time.time())
                age = int(env.get('BACKUP_AGE', '100'))
                full_age = int(env.get('FULL_AGE', str(max(age, 3600))))
                error = env.get('BACKUP_ERROR') == '1'
                print(json.dumps([{'name':'zephium','status':{'code':0},'backup':[
                    {'type':'full','error':error,'timestamp':{'stop':now-full_age}},
                    {'type':'diff','error':error,'timestamp':{'stop':now-age}}]}]))
        elif 'psql' in args:
            assert '--no-password' in args and '-X' in args
            query = next(a for a in args if a.startswith('--command='))
            assert 'pg_stat_archiver' in query and 'pg_ls_waldir()' in query
            assert 'default_transaction_read_only=on' in ' '.join(args)
            print(env.get('ARCHIVE_OK','1') + '|' + env.get('WAL_BYTES','1024'))
        elif 'backup' in args:
            assert '--archive-check' in args and '--user' in args and 'postgres' in args
        else:
            assert 'scripts/notify.ts' in args and '--workdir' in args and 'bun' in args
    else:
        sys.exit(3)
else:
    sys.exit(4)
'''


class Backups(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='zephium-backup-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.bin = self.path/'bin'
        self.bin.mkdir()
        for name in ['stat','flock','timeout','docker','df']:
            p = self.bin/name
            p.write_text(FAKE)
            p.chmod(0o755)
        self.state = self.path/'state'
        self.state.mkdir(mode=0o700)
        self.config = self.path/'config'
        self.config.write_text('COMPOSE_PROJECT_UUID=production-uuid\nPOSTGRES_SERVICE=postgres\n'
            'WORKER_SERVICE=worker\nPGBACKREST_STANZA=zephium\nPOSTGRES_DATABASE=zephium\n'
            'POSTGRES_USER=zephium_owner\nMAX_WAL_BYTES=4294967296\nHOST_DISK_PATH='+str(self.path)+'\n')
        self.config.chmod(0o600)
        self.log = self.path/'docker.jsonl'
        self.env = {**os.environ,'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],
            'STATE_DIRECTORY':str(self.state),'DOCKER_LOG':str(self.log)}
        self.bash = shutil.which('bash')

    def run_script(self, name, *args, **env):
        result = subprocess.run([self.bash,str(ROOT/name),*args,str(self.config)],
            env={**self.env,**env},capture_output=True,text=True,timeout=8)
        self.assertNotIn('secret-fixture-marker',result.stdout+result.stderr)
        self.assertEqual(result.stderr,'')
        return result

    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_backup_exact_project_and_service_and_inner_deadline(self):
        self.assertEqual(self.run_script('backup.sh','full').returncode,0)
        executed = [a for a in self.calls() if a[0]=='exec']
        self.assertEqual(len(executed),1)
        self.assertIn('a'*64,executed[0])
        self.assertNotIn('b'*64,executed[0])
        self.assertIn('2700s',executed[0])
        self.assertIn('--type=full',executed[0])

    def test_missing_and_multiple_containers_fail_without_exec(self):
        for extra in [{'DUPLICATE':'postgres'},{'FAIL_PS':'1'},{}]:
            if not extra:
                self.config.write_text(self.config.read_text().replace('production-uuid','absent-uuid'))
            self.log.unlink(missing_ok=True)
            self.assertNotEqual(self.run_script('backup.sh','diff',**extra).returncode,0)
            self.assertFalse(any(a[0]=='exec' for a in self.calls()))

    def test_selector_command_substitution_fails_without_errexit(self):
        code = ('source "$1"; COMPOSE_PROJECT_UUID=production-uuid; '
                'got=$(select_container postgres); result=$?; '
                '[[ "$result" == 1 && -z "$got" ]]')
        for env in [{'DUPLICATE':'postgres'},{'FAIL_PS':'1'}]:
            result = subprocess.run([self.bash,'-c',code,'fixture',str(ROOT/'common.sh')],
                env={**self.env,**env},capture_output=True,text=True,timeout=8)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout,'')
            self.assertFalse(any(a[0]=='exec' for a in self.calls()))

    def test_required_config_ownership_and_modes_fail_closed(self):
        self.assertNotEqual(self.run_script('backup.sh','full',BAD_OWNER='1').returncode,0)
        self.config.chmod(0o644)
        self.assertNotEqual(self.run_script('backup.sh','full').returncode,0)
        self.config.chmod(0o600)
        self.config.write_text(self.config.read_text().replace('WORKER_SERVICE=worker\n',''))
        self.assertNotEqual(self.run_script('backup.sh','full',WORKER_SERVICE='worker').returncode,0)
        self.assertEqual(self.calls(),[])

    def test_lock_conflict_skips_but_lock_errors_fail(self):
        self.assertEqual(self.run_script('backup.sh','full',LOCK_BUSY='1').returncode,0)
        self.assertNotEqual(self.run_script('backup.sh','full',LOCK_FAIL='1').returncode,0)
        self.assertEqual(self.calls(),[])

    def test_failed_and_timed_out_backup_is_generic_failure(self):
        for env in [{'FAIL_EXEC':'1'},{'TIMEOUT_EXEC':'1'}]:
            self.assertNotEqual(self.run_script('backup.sh','diff',**env).returncode,0)

    def test_monitor_fresh_backup_and_scalar_checks(self):
        self.assertEqual(self.run_script('monitor.sh').returncode,0)
        self.assertEqual(self.run_script('monitor.sh',DISK_FREE='15').returncode,0)
        self.assertEqual(self.run_script('monitor.sh',WAL_BYTES='4294967296').returncode,0)

    def test_monitor_fresh_diff_does_not_hide_stale_full(self):
        self.assertNotEqual(self.run_script('monitor.sh',FULL_AGE='691201').returncode,0)
        self.assertEqual(self.run_script('monitor.sh',FULL_AGE='604800').returncode,0)

    def test_monitor_stale_archive_wal_disk_and_tool_failures(self):
        cases = [{'BACKUP_AGE':'108001'},{'BACKUP_AGE':'-10'},{'ARCHIVE_OK':'0'},
            {'WAL_BYTES':'4294967297'},{'DISK_FREE':'14'},{'FAIL_EXEC':'1'},
            {'BAD_JSON':'1'},{'BACKUP_ERROR':'1'},{'TIMEOUT_EXEC':'1'}]
        for env in cases:
            with self.subTest(env=env):
                self.assertNotEqual(self.run_script('monitor.sh',**env).returncode,0)

    def test_alert_worker_isolation_and_one_hour_attempt_cooldown(self):
        self.assertEqual(self.run_script('alert.sh','backup_monitor_failed').returncode,0)
        self.assertEqual(self.run_script('alert.sh','backup_monitor_failed').returncode,0)
        executed = [a for a in self.calls() if a[0]=='exec']
        self.assertEqual(len(executed),1)
        self.assertIn('c'*64,executed[0])
        self.assertIn('backup_monitor_failed',executed[0])
        stamp = self.state/'backup_monitor_failed.last-attempt'
        stamp.write_text(str(int(time.time())-3601)+'\n')
        self.assertEqual(self.run_script('alert.sh','backup_monitor_failed').returncode,0)
        self.assertEqual(len([a for a in self.calls() if a[0]=='exec']),2)

    def test_failed_alert_is_also_cooled_down(self):
        self.assertNotEqual(self.run_script('alert.sh','backup_failed',FAIL_EXEC='1').returncode,0)
        self.assertEqual(self.run_script('alert.sh','backup_failed',FAIL_EXEC='1').returncode,0)
        self.assertEqual(len([a for a in self.calls() if a[0]=='exec']),1)


if __name__ == '__main__':
    unittest.main()
