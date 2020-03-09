const AWS = require('aws-sdk');
const moment = require('moment');
const request = require('request');
const fs = require('fs');

const REGIONS = [
    'us-east-2',
    'us-east-1',
    'us-west-1',
    'us-west-2',
    'ap-south-1',
    //'ap-northeast-3',
    'ap-northeast-2',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'ca-central-1',
    //'cn-north-1',
    //'cn-northwest-1',
    'eu-central-1',
    'eu-west-1',
    'eu-west-2',
    'eu-west-3',
    'eu-north-1',
    'sa-east-1',
];

const UTC_OFFSET = 540;

async function checkVolumes(region, accountId) {
    const result = {
        region: region,
        volumes: []
    };

    const ec2 = new AWS.EC2({apiVersion: '2016-11-15', region: region});

    // Volume
    {
        const params = {};
        const response = await ec2.describeVolumes(params).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
        } else {
            result.volumes = await Promise.all(response.Volumes.map(v => {
                const volume = {
                    category: 'volume',
                    id: v.VolumeId,
                    size: v.Size,
                    since: v.CreateTime,
                    region: region
                };
                v.Tags.forEach(t => {
                    switch (t.Key) {
                        case 'Name':
                            volume.name = t.Value;
                            break;
                        case 'Billing':
                            volume.billing = t.Value;
                            break;
                    }
                });
                return findInstance(ec2, v.Attachments.map(a => a.InstanceId)).then(instances => {
                    volume.attachedTo = instances.map(i => i.instanceId).join(',');
                    volume.attachedToName = instances.map(i => i.name).join(',');
                    return volume;
                });
            }));
        }
    }

    // Snapshot
    {
        const params = {
            OwnerIds: [accountId]
        };
        const response = await ec2.describeSnapshots(params).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
        } else {
            result.volumes = result.volumes.concat(await Promise.all(response.Snapshots.map(s => {
                const snapshot = {
                    category: 'snapshot',
                    id: s.SnapshotId,
                    size: s.VolumeSize,
                    since: s.StartTime,
                    region: region
                };
                s.Tags.forEach(t => {
                    switch (t.Key) {
                        case 'Name':
                            snapshot.name = t.Value;
                            break;
                        case 'Billing':
                            snapshot.billing = t.Value;
                            break;
                    }
                });
                return findImage(ec2, s.SnapshotId).then(images => {
                    snapshot.attachedTo = images.map(i => i.imageId).join(',');
                    snapshot.attachedToName = images.map(i => i.name).join(',');
                    return snapshot;
                });
            })));
        }
    }

    return result;
}

async function findInstance(ec2, instanceIds) {
    const params = {
        InstanceIds: instanceIds
    };

    const response = await ec2.describeInstances(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
        return [];
    } else {
        const instances = [];
        response.Reservations.forEach(r => {
            r.Instances.forEach(i => {
                instances.push({
                    instanceId: i.InstanceId,
                    name: i.Tags.some(t => t.Key === 'Name') ? i.Tags.find(t => t.Key === 'Name').Value : undefined
                });
            });
        });
        return instances;
    }
}

async function findImage(ec2, snapshotId) {
    const params = {
        Filters: [{
            Name: 'block-device-mapping.snapshot-id',
            Values: [snapshotId]
        }]
    };

    const response = await ec2.describeImages(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
        return [];
    } else {
        return response.Images.map(i => {
            return {
                imageId: i.ImageId,
                name: i.Name
            };
        });
    }
}

async function checkAddresses(region) {
    const result = {
        region: region,
        addresses: []
    };

    const ec2 = new AWS.EC2({apiVersion: '2016-11-15', region: region});
    const params = {};

    const response = await ec2.describeAddresses(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        response.Addresses.forEach(a => {
            const address = {
                publicIp: a.PublicIp,
                associatedWith: a.InstanceId,
                region: region
            };
            a.Tags.forEach(t => {
                switch (t.Key) {
                    case 'Name':
                        address.name = t.Value;
                        break;
                    case 'Billing':
                        address.billing = t.Value;
                        break;
                }
            });
            result.addresses.push(address);
        });
    }

    return result;
}

async function writeToS3(lines, title) {
    const bucket = process.env['S3_BUCKET'];
    if (!bucket) {
        console.log(`No S3_BUCKET in environment`);
        return;
    }

    await new Promise(function(resolve, reject) {
        fs.writeFile('/tmp/tmp.txt', lines.join('\n'), function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });

    const s3 = new AWS.S3();
    const s3Params = {
        Bucket: bucket,
        Key: `ec2-extra/${title}_${moment().format('YYYYMMDDHHmmss')}.csv`,
        Body: fs.readFileSync('/tmp/tmp.txt')
    };
    return s3.putObject(s3Params).promise();
}

async function postToSlack(lines) {
    const url = process.env['SLACK_WEBHOOK_URL'];
    if (!url) {
        console.log(`No SLACK_WEBHOOK_URL in environment`);
        return;
    }

    const options = {
        url: url,
        headers: {
            'Content-type': 'application/json'
        },
        body: {
            "text": lines.join('\n')
        },
        json: true
    };

    return new Promise((resolve, reject) => {
        request.post(options, function(error, response, body) {
            if (!error && response.statusCode == 200) {
                resolve(body);
            } else {
                console.log('error: ' + response.statusCode);
                reject();
            }
        });
    });
}

async function monitorEbs(event, context) {
    const regions = event.regions ? event.regions : REGIONS;
    const accountId = context.invokedFunctionArn.split(':')[4];
    const results = await Promise.all(regions.map(r => checkVolumes(r, accountId)));

    const lines = ['category,id,name,billing,size,since,attachedTo,attachedToName,region'];
    const noBillings = [];
    const agedVolumes = [];
    const agedSnapshots = [];
    const agedWhitelist = process.env['AGED_WHITELIST'].split(',');
    const current = moment();
    results.filter(result => result.volumes.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.volumes.length}`);
        result.volumes.forEach(v => {
            lines.push([v.category, v.id, v.name, v.billing, v.size, moment(v.since).utcOffset(UTC_OFFSET).format('YYYY/MM/DD'), v.attachedTo, v.attachedToName, v.region].join(','));
            if (!v.billing) {
                noBillings.push(v);
            }
            if (v.category === 'volume' && current.diff(moment(v.since), 'year') >= 2) {
                if (agedWhitelist.indexOf(v.name) < 0) {
                    agedVolumes.push(v);
                }
            }
            if (v.category === 'snapshot' && current.diff(moment(v.since), 'year') >= 3) {
                if (agedWhitelist.indexOf(v.name) < 0) {
                    agedSnapshots.push(v);
                }
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines, 'ebs_volumes');
    }

    // if (noBillings.length > 0) {
    //     const alertLines = [`EBS volumes with no Billing-tag found!\n`];
    //     noBillings.forEach(v => {
    //         alertLines.push(`\`${v.name}\` (category: ${v.category}, id: ${v.id}, size: ${v.size}, since: ${moment(v.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, attachedTo: ${v.attachedToName}(${v.attachedTo}), region: ${v.region})`);
    //     });
    //     console.log(alertLines.join('\n'));
    //     if (event.postToSlack) {
    //         await postToSlack(alertLines);
    //     }
    // }

    if (agedVolumes.length > 0) {
        const alertLines = [`Old EBS volumes (over 2 years) found!\n`];
        agedVolumes.forEach(v => {
            alertLines.push(`\`${v.name}\` (id: ${v.id}, billing: ${v.billing}, size: ${v.size}, since: ${moment(v.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, attachedTo: ${v.attachedToName}(${v.attachedTo}), region: ${v.region})`);
        });
        console.log(alertLines.join('\n'));
        if (event.postToSlack) {
            await postToSlack(alertLines);
        }
    }

    if (agedSnapshots.length > 0) {
        const alertLines = [`Old EBS snapshots (over 3 years) found!\n`];
        agedSnapshots.forEach(v => {
            alertLines.push(`\`${v.name}\` (id: ${v.id}, billing: ${v.billing}, size: ${v.size}, since: ${moment(v.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, attachedTo: ${v.attachedToName}(${v.attachedTo}), region: ${v.region})`);
        });
        console.log(alertLines.join('\n'));
        if (event.postToSlack) {
            await postToSlack(alertLines);
        }
    }

    return results;
}

async function monitorEip(event, context) {
    const regions = event.regions ? event.regions : REGIONS;
    const results = await Promise.all(regions.map(checkAddresses));

    const lines = ['publicIp,name,associatedWith,billing,region'];
    const noBillings = [];
    results.filter(result => result.addresses.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.addresses.length}`);
        result.addresses.forEach(a => {
            lines.push([a.publicIp, a.name, a.associatedWith, a.billing, a.region].join(','));
            if (!a.billing && !a.associatedWith) {
                noBillings.push(a);
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines, 'eip_addresses');
    }

    if (noBillings.length > 0) {
        const alertLines = [`Unused Elastic IP with no Billing-tag found!\n`];
        noBillings.forEach(a => {
            alertLines.push(`\`${a.name}\` (publicIp: ${a.publicIp}, region: ${a.region})`);
        });
        console.log(alertLines.join('\n'));
        if (event.postToSlack) {
            await postToSlack(alertLines);
        }
    }

    return results;
}

exports.handler = async (event, context) => {
    console.log(event);

    const results = [];
    results.push(...await monitorEbs(event, context));
    results.push(...await monitorEip(event, context));

    const response = {
        statusCode: 200,
        body: JSON.stringify(results),
    };
    return response;
};