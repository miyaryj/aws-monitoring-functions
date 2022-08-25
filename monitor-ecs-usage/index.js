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

const CPU_PRICE_PER_HOUR = 0.04048;
const MEMORY_PRICE_PER_HOUR = 0.004445;

async function checkTasks(region) {
    const result = {
        region: region,
        tasks: []
    };

    const ecs = new AWS.ECS({apiVersion: '2014-11-13', region: region});

    let params = {};
    let response = await ecs.listClusters(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        const tasks = await Promise.all(response.clusterArns.map(arn => {
            const cluster = arn.split("/")[1];
            return checkClusterTasks(ecs, cluster, region);
        }));
        result.tasks = tasks.flat();
    }

    return result;
}

async function checkClusterTasks(ecs, cluster, region) {
    let params = {
        cluster: cluster,
        desiredStatus: "RUNNING"
    };
    let response = await ecs.listTasks(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
        return [];
    }
    
    if (response.taskArns.length) {
        params = {
            cluster: cluster,
            tasks: response.taskArns
        };
        response = await ecs.describeTasks(params).promise();
        if (response.err) {
            console.log(response.err, response.err.stack);
            return [];
        }
        const tasks = response.tasks.map(t => {
            const task = {
                arn: t.taskArn,
                name: t.taskDefinitionArn.split("/")[1],
                cluster: cluster,
                type: t.launchType,
                cpu: t.cpu,
                memory: t.memory,
                since: t.startedAt,
                region: region
            };
            task.pricePerHour = (task.cpu/1024) * CPU_PRICE_PER_HOUR + (task.memory/1024) * MEMORY_PRICE_PER_HOUR;
            task.pricePerMonth = task.pricePerHour * 24 * 30;
            return task;
        });
        await Promise.all(tasks.map(t => setTags(ecs, t)));
        return tasks;
    }
    return [];
}

async function setTags(ecs, task, arn) {
    var params = {
        resourceArn: task.arn
    };
    let response = await ecs.listTagsForResource(params).promise();
    if (response.err) {
        console.log(response.err, response.err.stack);
    } else {
        response.tags.forEach(t => {
            if (t.key === "Billing") {
                task.billing = t.value;
            }
        });
    }
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
        Key: `ecs/ecs_tasks_${moment().format('YYYYMMDDHHmmss')}.csv`,
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
    const results = await Promise.all(regions.map(checkTasks));

    const lines = ['name, cluster, billing, type, cpu, memory, pricePerHour, pricePerMonth, since, region'];
    const noBillings = [];
    results.filter(result => result.tasks.length > 0).forEach(result => {
        console.log(`${result.region}: ${result.tasks.length}`);
        result.tasks.forEach(x => {
            lines.push([x.name, x.cluster, x.billing, x.type, x.cpu, x.memory, x.pricePerHour, x.pricePerMonth, moment(x.since).utcOffset(UTC_OFFSET).format('YYYY/MM/DD'), x.region].join(','));
            if (x.type === "FARGATE" && !x.billing) {
                noBillings.push(x);
            }
        });
    });

    console.log(lines.join('\n'));
    if (event.writeToS3) {
        await writeToS3(lines);
    }

    if (noBillings.length > 0) {
        const alertLines = [`Fargate tasks with no Billing-tag found!\n`];
        noBillings.forEach(x => {
            alertLines.push(`\`${x.name}\` (cluster: ${x.cluster}, cpu: ${x.cpu}, memory: ${x.memory}, since: ${moment(x.since).utcOffset(UTC_OFFSET).format('YYYY-MM-DD')}, region: ${x.region})`);
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
