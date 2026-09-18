pipeline {
    agent any

    tools {
        nodejs 'node-24-lts'
    }

    options {
        // Pipeline script from SCM이 자동으로 수행하는
        // 기본 Checkout을 막고 아래 Checkout stage에서 한 번만 수행
        skipDefaultCheckout(true)

        // Jenkins 로그에 시간 표시
        timestamps()

        // 동일 Pipeline 동시 실행 방지
        disableConcurrentBuilds()

        // 최근 빌드 20개만 보관
        buildDiscarder(
            logRotator(
                numToKeepStr: '20'
            )
        )
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Environment') {
            steps {
                sh '''
                    echo "=== Build Environment ==="
                    echo "Node   : $(node --version)"
                    echo "npm    : $(npm --version)"
                    echo "Git    : $(git --version)"
                    echo "Branch : $(git rev-parse --abbrev-ref HEAD)"
                    echo "Commit : $(git rev-parse --short HEAD)"
                '''
            }
        }

        stage('Install') {
            steps {
                dir('api') {
                    sh 'npm ci'
                }
            }
        }

        stage('Test') {
            steps {
                dir('api') {
                    sh 'npm test'
                }
            }
        }
    }

    post {

        success {
            echo 'Rinolab build SUCCESS'
        }

        failure {
            echo 'Rinolab build FAILED'
        }

        always {
            cleanWs()
        }
    }
}