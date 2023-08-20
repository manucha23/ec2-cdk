import * as cdk from 'aws-cdk-lib';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { LinuxBuildImage, PipelineProject } from 'aws-cdk-lib/aws-codebuild';
import { InstanceTagSet, ServerApplication, ServerDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import { Artifact, Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { CodeBuildAction, CodeDeployServerDeployAction, GitHubSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { AmazonLinuxCpuType, AmazonLinuxGeneration, AmazonLinuxImage, Instance, InstanceClass, InstanceSize, InstanceType, LaunchTemplate, Peer, Port, SecurityGroup, SubnetType, UserData, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';

export class Ec2CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //Create role for EC2
    const webServerRole = new Role(this, "ec2Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
    });
    
    webServerRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));

    webServerRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2RoleforAWSCodeDeploy"))

    //Setup VPC
    const vpc = new Vpc(this, 'main-vps', {
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'pub01',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'pub02',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 28,
          name: 'pub03',
          subnetType: SubnetType.PUBLIC,
        }
      ]
    });

    //Set Security group
    const webSg = new SecurityGroup(this, 'web_sg', {
      vpc,
      description: "Allows all inbound HTTP traffic to the web server",
      allowAllOutbound: true
    });

    webSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80));
    webSg.addIngressRule(Peer.anyIpv4(), Port.tcp(22));

    //Define AMI
    const ami = new AmazonLinuxImage({
      generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      cpuType: AmazonLinuxCpuType.X86_64
    });

    //Define EC2 with AMI, SG and Role
    const webServer1 = new Instance(this, 'web_server1', {
      vpc,
      instanceType: InstanceType.of(
        InstanceClass.T3,
        InstanceSize.NANO
      ),
      machineImage: ami,
      securityGroup: webSg,
      role: webServerRole
    })

    const webServer2 = new Instance(this, 'web_server2', {
      vpc,
      instanceType: InstanceType.of(
        InstanceClass.T3,
        InstanceSize.NANO
      ),
      machineImage: ami,
      securityGroup: webSg,
      role: webServerRole
    })

    //Add user data to EC2 to setup java
    const webSGUserData = readFileSync('./assets/configure_amz_linux_java_app.sh','utf-8');
    webServer1.addUserData(webSGUserData);
    webServer2.addUserData(webSGUserData);

    cdk.Tags.of(webServer1).add('application-name','java-web');
    cdk.Tags.of(webServer1).add('stage','prod');

    cdk.Tags.of(webServer2).add('application-name','java-web');
    cdk.Tags.of(webServer2).add('stage','prod');

    new cdk.CfnOutput(this, "IP Address", {
      value: webServer1.instancePublicIp + "," + webServer2.instancePublicIp
    });

    //Setup codedeploy pipeline
    const pipeline = new Pipeline(this, 'springboot-web-pipeline', {
      pipelineName: 'java-webapp',
      crossAccountKeys: false
    });

    //Stages
    const sourceStage = pipeline.addStage({
      stageName: 'Source'
    });

    const buildStage = pipeline.addStage({
      stageName: 'Build'
    });

    const deployStage = pipeline.addStage({
      stageName: 'Deploy'
    });

    //Source Action
    const sourceOutput = new Artifact();
    const githubSourceAction = new GitHubSourceAction({
      actionName: 'GithubSource',
      oauthToken: cdk.SecretValue.secretsManager('github-oauth-token'),
      owner: 'manucha23',
      repo: 'aws-springboot-app',
      branch: 'main',
      output: sourceOutput
    });

    sourceStage.addAction(githubSourceAction);

    // Build Action
    const springBootTestProject = new PipelineProject(this, 'springBootTestProject',{
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_5
      }
    });

    const springBootBuildOutput = new Artifact();

    const springBootBuildAction = new CodeBuildAction({
      actionName: 'BuildApp',
      project: springBootTestProject,
      input: sourceOutput,
      outputs: [springBootBuildOutput]
    });

    buildStage.addAction(springBootBuildAction);
    
    // Deploy Actions
    const springBootDeployApplication = new ServerApplication(this,"springboot_deploy_application",{
      applicationName: 'aws-springboot-webApp'
    });

    // Deployment group
    const springBootServerDeploymentGroup = new ServerDeploymentGroup(this,'SpringBootAppDeployGroup',{
      application: springBootDeployApplication,
      deploymentGroupName: 'SpringBootAppDeploymentGroup',
      installAgent: true,
      ec2InstanceTags: new InstanceTagSet(
      {
        'application-name': ['java-web'],
        'stage':['prod']
      })
    });

    // Deployment action
    const springBootDeployAction = new CodeDeployServerDeployAction({
      actionName: 'springBootAppDeployment',
      input: springBootBuildOutput,
      deploymentGroup: springBootServerDeploymentGroup,
    });

    deployStage.addAction(springBootDeployAction);
    
  }
}
