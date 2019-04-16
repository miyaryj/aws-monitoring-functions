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
        tables: []
    };

    const dynamodb = new AWS.DynamoDB({apiVersion: '2012-08-10', region: region});

    let params = {};
    let response = await dynamodb.listTables(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        result.tables = await Promise.all(response.TableNames.map(t => {
            const table = {
                name: t,
                region: region
            };
            return setProperties(dynamodb, t, table);
        }));
    }

    return result;
}

async function setProperties(dynamodb, name, target) {
    let params = {
        TableName : name
    };
    let response = await dynamodb.describeTable(params).promise();
    target.rcu = response.Table.ProvisionedThroughput.ReadCapacityUnits;
    target.wcu = response.Table.ProvisionedThroughput.WriteCapacityUnits;
    target.since = response.Table.CreationDateTime;

    params = {
        ResourceArn : response.Table.TableArn
    };
    response = await dynamodb.listTagsOfResource(params).promise();
    response.Tags.forEach(t => {
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
        Key: `dynamodb/dynamodb_tables_${moment().format('YYYYMMDDHHmmss')}.csv`,
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

    const lines = ['name, billing, rcu, wcu, since, region'];
    const noBillings = [];
    results.filter(result => result.tables.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.tables.length}`);
        result.tables.forEach(i => {
            lines.push([i.name, i.billing, i.rcu, i.wcu, moment(i.since).utcOffset(UTC_OFFSET).format('YYYY/MM/DD'), i.region].join(','));
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
        const alertLines = [`DynamoDB tables with no Billing-tag found!\n`];
        noBillings.forEach(i => {
            alertLines.push(`\`${i.name}\` (rcu: ${i.rcu}, wcu: ${i.wcu}, since: ${moment(i.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, region: ${i.region})`);
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
