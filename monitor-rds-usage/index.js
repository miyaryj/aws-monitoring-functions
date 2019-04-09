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

async function checkInstances(region) {
    const result = {
        region: region,
        instances: []
    };

    const rds = new AWS.RDS({apiVersion: '2014-10-31', region: region});

    let params = {};
    let response = await rds.describeDBInstances(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        result.instances = await Promise.all(response.DBInstances.filter(i => {
            return i.DBInstanceStatus === 'available';
        }).map(i => {
            const instance = {
                name: i.DBInstanceIdentifier,
                type: i.DBInstanceClass,
                since: i.InstanceCreateTime,
                region: region
            };
            console.log(instance);
            return setTags(rds, i.DBInstanceArn, instance);
        }));
    }

    return result;
}

async function setTags(rds, arn, target) {
    const params = {
        ResourceName : arn
    };
    const response = await rds.listTagsForResource(params).promise();
    response.TagList.forEach(t => {
        switch (t.Key) {
            case 'Billing':
                target.billing = t.Value;
                break;
        }
    });
    return target;
}

async function writeToS3(lines) {
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
        Key: `rds/rds_instances_${moment().format('YYYYMMDDHHmmss')}.csv`,
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

exports.handler = async (event) => {
    console.log(event);

    const regions = event.regions ? event.regions : REGIONS;
    const results = await Promise.all(regions.map(checkInstances));

    const lines = ['name, billing, type, since, region'];
    const noBillings = [];
    results.filter(result => result.instances.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.instances.length}`);
        result.instances.forEach(i => {
            lines.push([i.name, i.billing,i.type, moment(i.since).utcOffset(UTC_OFFSET).format('YYYY/MM/DD'), i.region].join(','));
            if (!i.billing) {
                noBillings.push(i);
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines);
    }

    if (noBillings.length > 0) {
        const alertLines = [`RDS instances with no Billing-tag found!\n`];
        noBillings.forEach(i => {
            alertLines.push(`\`${i.name}\` (type: ${i.type}, since: ${moment(i.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, region: ${i.region})`);
        });
        console.log(alertLines.join('\n'));
        if (event.postToSlack) {
            await postToSlack(alertLines);
        }
    }

    const response = {
        statusCode: 200,
        body: JSON.stringify(results),
    };
    return response;
};
