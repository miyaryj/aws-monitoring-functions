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

    // Classic
    let classicLbs = [];
    const elbClassic = new AWS.ELB({apiVersion: '2012-06-01', region: region});

    let params = {};
    let response = await elbClassic.describeLoadBalancers(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        classicLbs = response.LoadBalancerDescriptions.map(lb => {
            return {
                name: lb.LoadBalancerName,
                type: 'classic',
                since: lb.CreatedTime,
                region: region
            };
        });

        if (classicLbs.length > 0) {
            params = {
                LoadBalancerNames: classicLbs.map(i => i.name)
            };
            response = await elbClassic.describeTags(params).promise();
            if (response.err) {
                console.log(response.err, response.err.stack);
            } else {
                response.TagDescriptions.forEach(description => {
                    classicLbs.filter(i => i.name === description.LoadBalancerName).forEach(i => {
                        description.Tags.forEach(t => {
                            switch (t.Key) {
                                case 'Billing':
                                    i.billing = t.Value;
                                    break;
                            }
                        });
                    });
                });
            }
        }
    }
    result.instances = classicLbs;

    // Application / Network
    let lbs = [];
    const elb = new AWS.ELBv2({apiVersion: '2015-12-01', region: region});

    let marker = undefined;
    do {
        params = { PageSize: 20, Marker: marker };
        response = await elb.describeLoadBalancers(params).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
            break;
        } else {
            lbs = response.LoadBalancers.filter(lb => {
                return lb.State && lb.State.Code === 'active';
            }).map(lb => {
                return {
                    arn: lb.LoadBalancerArn,
                    name: lb.LoadBalancerName,
                    type: lb.Type,
                    since: lb.CreatedTime,
                    region: region
                };
            });
        }
        marker = response.NextMarker;

        if (lbs.length > 0) {
            params = {
                ResourceArns: lbs.map(i => i.arn)
            };
            response = await elb.describeTags(params).promise();
            if (response.err) {
                console.log(response.err, response.err.stack);
            } else {
                response.TagDescriptions.forEach(description => {
                    lbs.filter(i => i.arn === description.ResourceArn).forEach(i => {
                        description.Tags.forEach(t => {
                            switch (t.Key) {
                                case 'Billing':
                                    i.billing = t.Value;
                                    break;
                            }
                        });
                    });
                });
            }
        }

        result.instances = result.instances.concat(lbs);
    } while (marker);

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
        Key: `elb/elb_instances_${moment().format('YYYYMMDDHHmmss')}.csv`,
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
        const alertLines = [`ELB instances with no Billing-tag found!\n`];
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
