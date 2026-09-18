pipeline {
    agent any

    tools {
        nodejs 'node-24-lts'
    }

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    stages {
        stage('Checkout') {
            steps {
                git branch: 'main',
                    url: 'https://github.com/rino0914/rinolab.git'
            }
        }

        stage('Environment') {
            steps {
                sh '''
                    echo "Node: $(node --version)"
                    echo "npm : $(npm --version)"
                    echo "Git : $(git --version)"
                    echo "Commit: $(git rev-parse --short HEAD)"
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