pipeline {
    agent any

    options {
        skipDefaultCheckout(true)
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 15, unit: 'MINUTES')
        buildDiscarder(
            logRotator(
                numToKeepStr: '20'
            )
        )
    }

    stages {
        stage('Deploy') {
            steps {
                // 운영 문서의 root 소유 외부 실행본을 gwnam 권한으로 호출한다.
                // jenkins-admin에는 이 명령에 한정된 NOPASSWD 권한이 필요하다.
                // gwnam의 sudo -v와 스크립트 내부 sudo도 비대화형 실행이 가능해야 한다.
                sh '''#!/bin/sh
                    set -eu

                    printf '=== Deploy Environment ===\\n'
                    printf 'Build   : %s\\n' "$BUILD_NUMBER"
                    printf 'User    : %s\\n' "$(id -un)"
                    printf 'Node    : %s\\n' "$NODE_NAME"
                    printf 'Target  : %s\\n' 'jenkins-admin@host.docker.internal'
                    printf 'Started : %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

                    exec ssh -nT \\
                        -i /var/jenkins_home/.ssh/rinolab_deploy \\
                        -o BatchMode=yes \\
                        -o IdentitiesOnly=yes \\
                        -o StrictHostKeyChecking=yes \\
                        -o UserKnownHostsFile=/var/jenkins_home/.ssh/known_hosts \\
                        -o ConnectTimeout=10 \\
                        -o ServerAliveInterval=15 \\
                        -o ServerAliveCountMax=3 \\
                        jenkins-admin@host.docker.internal \\
                        'sudo -n -H -u gwnam -- /usr/local/libexec/rinolab-deploy/deploy.sh'
                '''
            }
        }
    }

    post {
        success {
            echo 'Rinolab deploy SUCCESS'
        }

        failure {
            echo 'Rinolab deploy FAILED'
        }

        aborted {
            echo 'Rinolab deploy ABORTED (cancelled or timed out)'
        }
    }
}
