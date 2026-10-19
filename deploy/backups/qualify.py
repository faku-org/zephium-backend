#!/usr/bin/env python3
"""Exercise the real encrypted S3 repository using disposable PostgreSQL containers.
Run as a trusted Docker operator. Credentials are read from a private file, never argv.
No connection to application databases is made. Uses only synthetic canary records.
"""
import argparse, configparser, hashlib, json, os, re, secrets, signal, stat, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--config',required=True,type=Path)
parser.add_argument('--image',required=True)
parser.add_argument('--directory',required=True,type=Path)
args=parser.parse_args()
if os.geteuid()!=0:sys.exit('Run as the trusted host operator (root).')
if not re.fullmatch(r'ghcr\.io/zephium-browser/backend/postgres@sha256:[a-f0-9]{64}',args.image):sys.exit('Pinned PostgreSQL image required.')
if args.config.is_symlink() or not args.config.is_file() or stat.S_IMODE(args.config.stat().st_mode)&0o077:sys.exit('Private regular configuration required.')
args.directory.mkdir(mode=0o700,parents=False,exist_ok=False)
os.chmod(args.directory,0o700)
run_id='zbackup-'+secrets.token_hex(6)
prefix='/zephium/qualification/'+run_id
source=run_id+'-source'; restored=run_id+'-restore'
source_volume=run_id+'-source'; restore_volume=run_id+'-restore'
containers=[]; helpers=[]; volumes=[]; stage='initialize'; passed=False
helper_sequence=0
report={'run_id':run_id,'repository_prefix':prefix,'image':args.image,'started_at':datetime.now(timezone.utc).isoformat(),'synthetic_data_only':True,'live_database_untouched':True}

def interrupted(_signum,_frame):
    raise RuntimeError('operator_interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)

def command(argv,timeout=60,check=True,input_text=None):
    result=subprocess.run(argv,input=input_text,text=True,errors="replace",stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False)
    if check and result.returncode:raise RuntimeError('command_failed')
    return result

def docker(*argv,timeout=60,check=True,input_text=None):
    global helper_sequence
    argv=list(argv)
    if argv and argv[0]=='run' and '--rm' in argv:
        helper_sequence+=1
        name=run_id+'-helper-'+str(helper_sequence)
        helpers.append(name)
        argv[1:1]=['--name',name,'--label','app=zephium-backup-qualification']
    return command(['docker',*argv],timeout,check,input_text)

def mark(value):
    global stage
    stage=value
    print(json.dumps({'stage':stage}),flush=True)

def pgbackrest(container,*argv,check=True):
    return docker('exec','-u','postgres',container,'pgbackrest','--stanza=zephium','--log-level-console=error',*argv,timeout=600,check=check)

def sql(container,value):
    return docker('exec','-i','-u','postgres',container,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','zephium_owner','-d','zephium_probe',input_text=value,timeout=60).stdout.strip()

def ready(container):
    for _ in range(90):
        if docker('exec',container,'pg_isready','-U','zephium_owner','-d','zephium_probe',check=False).returncode==0:return
        time.sleep(1)
    raise RuntimeError('database_start_timeout')

def new_volume(name):
    docker('volume','create','--label','app=zephium-backup-qualification',name)
    volumes.append(name)

def start(name,volume,restore=False):
    argv=['run','-d','--name',name,'--label','app=zephium-backup-qualification','--memory=512m','--cpus=0.5','--pids-limit=128','--security-opt=no-new-privileges:true',
        '--mount',f'type=volume,source={volume},target=/var/lib/postgresql',
        '--mount',f'type=bind,source={config},target=/etc/pgbackrest/pgbackrest.conf,readonly',
        '--mount',f'type=bind,source={password_file},target=/run/secrets/test-password,readonly',
        '-e','POSTGRES_USER=zephium_owner','-e','POSTGRES_DB=zephium_probe','-e','POSTGRES_PASSWORD_FILE=/run/secrets/test-password',args.image,
        'postgres','-c','shared_buffers=64MB','-c','max_connections=10','-c','logging_collector=off','-c','log_statement=none','-c','log_min_error_statement=panic']
    if restore:argv+=['-c','archive_mode=off']
    else:argv+=['-c','wal_level=replica','-c','archive_mode=on','-c','archive_timeout=60s','-c','archive_command=pgbackrest --stanza=zephium archive-push %p']
    containers.append(name);docker(*argv);ready(name)
    if restore:
        for _ in range(90):
            if sql(name,'SELECT pg_is_in_recovery();')=='f':break
            time.sleep(1)
        else:raise RuntimeError('restore_promotion_timeout')

try:
    mark('inspect_pinned_image')
    docker('image','inspect',args.image)
    uid=int(docker('run','--rm','--network=none','--entrypoint=id',args.image,'-u','postgres').stdout.strip())
    gid=int(docker('run','--rm','--network=none','--entrypoint=id',args.image,'-g','postgres').stdout.strip())
    report['pgbackrest_version']=docker('run','--rm','--network=none','--entrypoint=pgbackrest',args.image,'version').stdout.strip()
    original=configparser.ConfigParser(interpolation=None);original.read(args.config)
    if original.defaults() or set(original.sections())!={'global','zephium'}:
        raise RuntimeError('unexpected_configuration_sections')
    allowed={'repo1-type','repo1-path','repo1-s3-endpoint','repo1-s3-region','repo1-s3-bucket','repo1-s3-uri-style','repo1-s3-key','repo1-s3-key-secret','repo1-cipher-type','repo1-cipher-pass','repo1-retention-full','repo1-retention-diff','repo1-retention-history','start-fast','archive-async','log-level-console','log-level-file','process-max'}
    if set(original['global'])-allowed or set(original['zephium'])-{'pg1-user','pg1-path'}:
        raise RuntimeError('unexpected_configuration_options')
    cfg=configparser.ConfigParser(interpolation=None)
    cfg['global']={key:original['global'][key] for key in ['repo1-s3-endpoint','repo1-s3-region','repo1-s3-bucket','repo1-s3-key','repo1-s3-key-secret','repo1-cipher-type','repo1-cipher-pass']}
    cfg['global'].update({'repo1-type':'s3','repo1-s3-uri-style':'path','repo1-retention-full-type':'count','start-fast':'y','archive-async':'n','log-level-console':'error','log-level-file':'off'})
    cfg['zephium']={'pg1-user':'zephium_owner','pg1-path':'/var/lib/postgresql/18/docker'}
    if cfg['global']['repo1-cipher-type']!='aes-256-cbc' or len(cfg['global']['repo1-cipher-pass'])<32:raise RuntimeError('encrypted_configuration_required')
    if cfg['global']['repo1-s3-bucket']!='zephium-production-backups' or cfg['global']['repo1-s3-endpoint']!='nbg1.your-objectstorage.com':raise RuntimeError('unexpected_repository_destination')
    cfg['global']['repo1-path']=prefix
    cfg['global']['repo1-retention-full']='3'
    cfg['global']['repo1-retention-diff']='10'
    cfg['global']['repo1-retention-history']='0'
    cfg['global']['process-max']='1'
    cfg['global']['archive-timeout']='120'
    cfg['zephium']['pg1-user']='zephium_owner'
    config=args.directory/'pgbackrest.conf'
    with config.open('w') as out:cfg.write(out)
    os.chmod(config,0o600);os.chown(config,uid,gid)
    password_file=args.directory/'password'
    password_file.write_text(secrets.token_urlsafe(32));os.chmod(password_file,0o600);os.chown(password_file,uid,gid)
    new_volume(source_volume);new_volume(restore_volume)
    mark('start_disposable_source')
    start(source,source_volume)
    pgbackrest(source,'stanza-create')
    sql(source,"CREATE TABLE recovery_fixture(id integer PRIMARY KEY, marker text NOT NULL, amount bigint NOT NULL); INSERT INTO recovery_fixture VALUES(1,'before-full',125000),(2,'held',250000);")
    pgbackrest(source,'check')
    mark('encrypted_full_backup')
    pgbackrest(source,'--type=full','backup')
    info=json.loads(pgbackrest(source,'--output=json','info').stdout)
    first=info[0]['backup'][-1]['label']
    if info[0].get('cipher')!='aes-256-cbc':raise RuntimeError('repository_not_encrypted')
    report['full_backup_label']=first
    # This committed row must be recovered from WAL after the first full backup.
    sql(source,"INSERT INTO recovery_fixture VALUES(3,'after-full-wal',350000); SELECT pg_create_restore_point('zephium_wal_probe'); SELECT pg_switch_wal();")
    pgbackrest(source,'check')
    mark('encrypted_differential_backup')
    pgbackrest(source,'--type=diff','backup')
    differential=json.loads(pgbackrest(source,'--output=json','info').stdout)[0]['backup'][-1]['label']
    report['differential_backup_label']=differential
    expected=sql(source,"SELECT md5(string_agg(id::text || ':' || marker || ':' || amount::text, ',' ORDER BY id)) FROM recovery_fixture;")
    report['fixture_digest']=expected
    mark('prepare_retention_test')
    time.sleep(2)
    pgbackrest(source,'--type=full','backup')
    time.sleep(2)
    pgbackrest(source,'--type=full','backup')
    mark('prepare_independent_restore')
    docker('run','--rm','--network=none','-u','root','--mount',f'type=volume,source={restore_volume},target=/var/lib/postgresql',args.image,'sh','-c','mkdir -p /var/lib/postgresql/18/docker && chown -R postgres:postgres /var/lib/postgresql')
    # Wrong-pass check reads the actual remote repository but cannot decrypt it.
    wrong=args.directory/'wrong-pass.conf'
    cfg['global']['repo1-cipher-pass']=secrets.token_urlsafe(48)
    with wrong.open('w') as out:cfg.write(out)
    os.chmod(wrong,0o600);os.chown(wrong,uid,gid)
    control=json.loads(pgbackrest(source,'--output=json','info').stdout)
    if len(control)!=1 or control[0].get('name')!='zephium' or control[0].get('status',{}).get('code')!=0:raise RuntimeError('valid_passphrase_control_failed')
    result=docker('run','--rm','-u','postgres','--mount',f'type=bind,source={wrong},target=/etc/pgbackrest/pgbackrest.conf,readonly',args.image,'pgbackrest','--stanza=zephium','--log-level-console=error','--output=text','info',check=False,timeout=120)
    if result.returncode!=0:raise RuntimeError('wrong_passphrase_probe_inconclusive')
    # Failed decryption may reach strict metadata parsing before cipher finalization.
    # Diagnostics can contain arbitrary decoded bytes: never print or JSON-parse them.
    message=result.stdout
    leaf_errors={'CryptoError','FormatError','ChecksumError'}
    outer_errors=set(re.findall(r'(?m)^\s*\[([A-Za-z]+Error)\]',message))
    nested_errors=set(re.findall(r'(?m)^\s*([A-Za-z]+Error):',message))
    if ('stanza: zephium' not in message or 'status: error' not in message
        or 'unable to load info file' not in message or not outer_errors
        or not outer_errors <= leaf_errors | {'FileOpenError'}
        or not nested_errors or not nested_errors <= leaf_errors):
        raise RuntimeError('wrong_passphrase_probe_inconclusive')
    report['wrong_passphrase_error_classes']=sorted(outer_errors | nested_errors)
    valid_info=json.loads(pgbackrest(source,'--output=json','info').stdout)
    if valid_info[0].get('status',{}).get('code')!=0:raise RuntimeError('valid_passphrase_control_failed')
    report['wrong_passphrase_rejected']=True
    wrong.unlink()
    # Remove the original source before recovery: only remote backup+WAL remain usable.
    docker('stop','--time=30',source);docker('rm',source);containers.remove(source)
    docker('volume','rm',source_volume);volumes.remove(source_volume)
    mark('restore_differential_backup')
    docker('run','--rm','-u','postgres','--memory=512m','--cpus=0.5','--mount',f'type=volume,source={restore_volume},target=/var/lib/postgresql','--mount',f'type=bind,source={config},target=/etc/pgbackrest/pgbackrest.conf,readonly',args.image,'pgbackrest','--stanza=zephium','--log-level-console=error',f'--set={differential}','--type=immediate','--archive-mode=off','restore',timeout=600)
    start(restored,restore_volume,restore=True)
    if sql(restored,"SELECT md5(string_agg(id::text || ':' || marker || ':' || amount::text, ',' ORDER BY id)) FROM recovery_fixture;")!=expected:
        raise RuntimeError('differential_restore_mismatch')
    report['differential_restore_verified']=True
    docker('stop','--time=30',restored);docker('rm',restored);containers.remove(restored)
    docker('volume','rm',restore_volume);volumes.remove(restore_volume)
    new_volume(restore_volume)
    docker('run','--rm','--network=none','-u','root','--mount',f'type=volume,source={restore_volume},target=/var/lib/postgresql',args.image,'sh','-c','mkdir -p /var/lib/postgresql/18/docker && chown -R postgres:postgres /var/lib/postgresql')
    mark('restore_full_plus_post_backup_wal')
    docker('run','--rm','-u','postgres','--memory=512m','--cpus=0.5','--mount',f'type=volume,source={restore_volume},target=/var/lib/postgresql','--mount',f'type=bind,source={config},target=/etc/pgbackrest/pgbackrest.conf,readonly',args.image,'pgbackrest','--stanza=zephium','--log-level-console=error',f'--set={first}','--type=name','--target=zephium_wal_probe','--target-action=promote','--archive-mode=off','restore',timeout=600)
    start(restored,restore_volume,restore=True)
    actual=sql(restored,"SELECT md5(string_agg(id::text || ':' || marker || ':' || amount::text, ',' ORDER BY id)) FROM recovery_fixture;")
    if actual!=expected:raise RuntimeError('restored_fixture_mismatch')
    if sql(restored,"SELECT pg_is_in_recovery();")!='f' or sql(restored,"SHOW archive_mode;")!='off':raise RuntimeError('restore_not_isolated_or_promoted')
    report['post_backup_wal_recovered']=True
    report['source_removed_before_restore']=True
    report['restored_archive_mode']='off'
    mark('expire_old_backup_without_breaking_retained_backups')
    pgbackrest(restored,'--repo1-retention-full=2','expire')
    retained=json.loads(pgbackrest(restored,'--output=json','info').stdout)[0]['backup']
    if first in [b['label'] for b in retained] or len([b for b in retained if b['type']=='full'])!=2:
        raise RuntimeError('retention_did_not_expire_oldest_full')
    report['pgbackrest_expiration_verified']=True
    docker('stop','--time=30',restored);docker('rm',restored);containers.remove(restored)
    docker('volume','rm',restore_volume);volumes.remove(restore_volume)
    new_volume(restore_volume)
    docker('run','--rm','--network=none','-u','root','--mount',f'type=volume,source={restore_volume},target=/var/lib/postgresql',args.image,'sh','-c','mkdir -p /var/lib/postgresql/18/docker && chown -R postgres:postgres /var/lib/postgresql')
    mark('restore_retained_backup_after_expiration')
    docker('run','--rm','-u','postgres','--memory=512m','--cpus=0.5','--mount',f'type=volume,source={restore_volume},target=/var/lib/postgresql','--mount',f'type=bind,source={config},target=/etc/pgbackrest/pgbackrest.conf,readonly',args.image,'pgbackrest','--stanza=zephium','--log-level-console=error','--type=immediate','--archive-mode=off','restore',timeout=600)
    start(restored,restore_volume,restore=True)
    if sql(restored,"SELECT md5(string_agg(id::text || ':' || marker || ':' || amount::text, ',' ORDER BY id)) FROM recovery_fixture;")!=expected:
        raise RuntimeError('retained_backup_restore_mismatch')
    report['restore_after_expiration_verified']=True
    report['status']='passed';passed=True
    mark('restore_verified')
except Exception as error:
    report['status']='failed';report['failed_stage']=stage;report['error_type']=type(error).__name__
    print(json.dumps({'status':'failed','stage':stage,'error_type':type(error).__name__}),flush=True)
finally:
    cleanup=True
    for name in helpers:
        try:
            removal=docker('rm','-f',name,check=False)
            if removal.returncode!=0:
                absent=docker('container','inspect',name,check=False)
                if absent.returncode!=1 or ('No such container: '+name not in absent.stderr and 'No such object: '+name not in absent.stderr):cleanup=False
        except Exception:cleanup=False
    for name in containers:
        try:docker('rm','-f',name)
        except Exception:cleanup=False
    for name in volumes:
        try:docker('volume','rm',name)
        except Exception:cleanup=False
    for name in ['pgbackrest.conf','password','wrong-pass.conf']:
        (args.directory/name).unlink(missing_ok=True)
    report['local_test_resources_removed']=cleanup
    report['finished_at']=datetime.now(timezone.utc).isoformat()
    output=args.directory/'report.json'
    output.write_text(json.dumps(report,indent=2)+'\n');os.chmod(output,0o600)
    print(json.dumps(report),flush=True)
    sys.exit(0 if passed and cleanup else 1)
