#!/usr/bin/env bash

filepath=
serverip=
key=
bastion="$EC2_BASTION"
usage="usage: $0 [-s internal IP] [-f filepath] [-i bastion key] [-b bastion location (defaults to env EC2_BASTION)]"
while [ $# -gt 0 ]
do
  case "$1" in
    -s) server="$2"; shift;;
    -f) filepath="$2"; shift;;
    -i) key="$2"; shift;;
    -b) bastion="$2"; shift;;
    --)	shift; break;;
    -*) echo >&2 \
        "$usage"
        exit 1;;
    *) break;;
  esac
  shift
done

if [ -z "$filepath" ] || [ -z "$server" ] ; then
  echo "$usage"
  exit 1
fi

echo "filepath $filepath"
echo "filename $(basename $filepath)"
echo "server $server"
echo "key $key"
echo "bastion $bastion"

scp -i "$key" "$filepath" "ec2-user@$bastion:/home/ec2-user/"
ssh "ec2-user@$bastion" -i "$key" << HERE
    scp "$(basename $filepath)" "$server:/home/ec2-user/"
    ssh "$server" "sudo tar -xzf $(basename $filepath) -C /var/www/ --strip-components=1 && sudo /usr/local/bin/forever restart media_api && sudo /usr/local/bin/forever list"
HERE

