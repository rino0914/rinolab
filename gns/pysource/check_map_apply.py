import os
import argparse
from enum import Enum

PATH_TABLE  = '/appl/table'
PATH_TRAMAP = '/appl/tramap'

SERVER_TYPE_TRACK   = 1
SERVER_TYPE_GENSPD  = 2
SERVER_TYPE_PREDICT = 3

SERVER_TYPE_STRING_TRACK   = "track"
SERVER_TYPE_STRING_GENSPD  = "genspd"
SERVER_TYPE_STRING_PREDICT = "predict"

ENV_PRD = 1
ENV_STG = 2
ENV_DEV = 2

ENV_STRING_PRD = "prd"
ENV_STRING_STG = "stg"
ENV_STRING_DEV = "dev"

DIGITS_MAPVER_UFI = 6
DIGITS_MAPVER_HAF = 5
DIGITS_DATE       = 8
class Loglevel(Enum):
    emerge = 0
    alert = 1
    crit = 2
    error = 3
    warning = 4
    notice = 5
    info = 6
    debug = 7

def log (msg,level=Loglevel.info):
    print(f'[{level.name}] f{msg}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='check validation of mapupdate')
    parser.add_argument('--map_date',     type=str, default=None, help='map date YYYYMMDD')
    parser.add_argument('--map_version',  type=str, default=None, help='map version')
    parser.add_argument('--server_type',  type=str, default=None, help='server type. track/genspd/predict',  choices=[SERVER_TYPE_STRING_TRACK, SERVER_TYPE_STRING_GENSPD, SERVER_TYPE_STRING_PREDICT])
    parser.add_argument('--env',          type=str, default=None, help='env. prd/stg/dev',                   choices=[ENV_STRING_PRD, ENV_STRING_STG, ENV_STRING_DEV])

    args = parser.parse_args()
    date = args.map_date
    date = args.map_version
    server_type = args.server_type

    
