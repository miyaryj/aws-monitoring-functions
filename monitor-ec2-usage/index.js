const AWS = require('aws-sdk');
const moment = require('moment');
const request = require('request');
const fs = require('fs');
const instanceTable = require('./region-instances');

const priceArray = Object.values(instanceTable.regions["US East (N. Virginia)"]).map(value => {
    return [value["Instance Type"], Number(value.price)];
});
const prices = Object.fromEntries(priceArray);

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

    const ec2 = new AWS.EC2({apiVersion: '2016-11-15', region: region});
    const params = {
        Filters: [{
            Name: "instance-state-name",
            Values: [
                "running"
            ]
        }]
    };

    const response = await ec2.describeInstances(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        response.Reservations.forEach(r => {
            r.Instances.forEach(i => {
                const instance = {
                    id: i.InstanceId,
                    type: i.InstanceType,
                    since: i.LaunchTime,
                    region: region
                };
                i.Tags.forEach(t => {
                    switch (t.Key) {
                        case 'Name':
                            instance.name = t.Value;
                            break;
                        case 'Billing':
                            instance.billing = t.Value;
                            break;
                    }
                });
                instance.pricePerHour = prices[instance.type];
                instance.pricePerMonth = instance.pricePerHour * 24 * 30;
                result.instances.push(instance);
            });
        });
    }

    return result;
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
        Key: `ec2/ec2_instances_${moment().format('YYYYMMDDHHmmss')}.csv`,
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

    const lines = ['instanceId,name,billing,instanceType,pricePerHour,pricePerMonth,since,region'];
    const noBillings = [];
    const longRuns = [];
    const longRunWhitelist = process.env['LONGRUN_WHITELIST'].split(',');
    const current = moment();
    results.filter(result => result.instances.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.instances.length}`);
        result.instances.forEach(i => {
            lines.push([i.id, i.name, i.billing, i.type, i.pricePerHour, i.pricePerMonth, moment(i.since).utcOffset(UTC_OFFSET).format('YYYY/MM/DD'), i.region].join(','));
            if (!i.billing) {
                noBillings.push(i);
            }
            if (i.pricePerHour >= 0.1 && current.diff(moment(i.since), 'day') >= 1) {
                if (longRunWhitelist.indexOf(i.name) < 0) {
                    longRuns.push(i);
                }
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines);
    }

    if (noBillings.length > 0) {
        const alertLines = [`EC2 instances with no Billing-tag found!\n`];
        noBillings.forEach(i => {
            alertLines.push(`\`${i.name}\` (id: ${i.id}, type: ${i.type}, since: ${moment(i.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, region: ${i.region})`);
        });
        console.log(alertLines.join('\n'));
        if (event.postToSlack) {
            await postToSlack(alertLines);
        }
    }

    if (longRuns.length > 0) {
        const alertLines = [`Long-run EC2 instances (over 1 day & 0.1 USD/hour) found!\n`];
        longRuns.forEach(i => {
            alertLines.push(`\`${i.name}\` (id: ${i.id}, billing: ${i.billing}, type: ${i.type}, since: ${moment(i.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, region: ${i.region})`);
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
