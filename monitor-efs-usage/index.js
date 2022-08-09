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

async function checkFileSystems(region) {
    const result = {
        region: region,
        fileSystems: []
    };

    const efs = new AWS.EFS({apiVersion: '2015-02-01', region: region});

    let params = {};
    let response = await efs.describeFileSystems(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        result.fileSystems = response.FileSystems.filter(fs => {
            return fs.LifeCycleState === "available";
        }).map(fs => {
            const billingTag = fs.Tags.find(t => t.Key === "Billing");
            return {
                id: fs.FileSystemId,
                name: fs.Name,
                billing: billingTag ? billingTag.Value : "",
                sizeInStandard: fs.SizeInBytes.ValueInStandard,
                sizeInIA: fs.SizeInBytes.ValueInIA,
                since: fs.CreationTime,
                region: region
            };
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
        Key: `efs/efs_filesystems_${moment().format('YYYYMMDDHHmmss')}.csv`,
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
    const results = await Promise.all(regions.map(checkFileSystems));

    const lines = ['id, name, billing, sizeInStandard, sizeInIA, since, region'];
    const noBillings = [];
    results.filter(result => result.fileSystems.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.fileSystems.length}`);
        result.fileSystems.forEach(x => {
            lines.push([x.id, x.name, x.billing, x.sizeInStandard, x.sizeInIA, moment(x.since).utcOffset(UTC_OFFSET).format('YYYY/MM/DD'), x.region].join(','));
            if (!x.billing) {
                noBillings.push(x);
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines);
    }

    if (noBillings.length > 0) {
        const alertLines = [`EFS file systems with no Billing-tag found!\n`];
        noBillings.forEach(x => {
            alertLines.push(`\`${x.name}\` (id: ${x.id}, sizeInStandard: ${x.sizeInStandard}, sizeInIA: ${x.sizeInIA}, since: ${moment(x.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, region: ${x.region})`);
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
